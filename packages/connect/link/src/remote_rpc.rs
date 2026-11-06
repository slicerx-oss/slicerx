// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The methods a paired phone or remote agent may call over the relay, in the envelope and with
//! the names of `packages/pair/src/rpc.ts`. Read: host info, printers, fleets, status, printer
//! events, stills, the relay quota. Act: pause or cancel through a card, and (phones with the
//! approve right) answer cards with a decision signed by the phone's identity key. Over the relay a
//! phone approves pause, cancel and skip-one-object cards, which only stop extrusion, and a start
//! (an agent's or partner's print, or a queued plate) only under the remote start rule
//! (`remote_start.rs`: the printer opted in, a fresh plate check that compared the plate with the
//! empty-plate picture, the temperature and chamber limits, and the person's signed plate answer).
//! The phone reads that check with `plate.check`, the still beside the empty-plate picture. It may
//! deny any card it sees. Scheduled starts, resume, raw G-code and adjustments are approved in the
//! app or at the printer. Never remote: `print.local`, `bed.confirmClear` (the person must be at
//! the printer), resume, uploads, secrets, printer setup, clients and settings. Approver phones also
//! read and answer the question mimir waits on in the app (`mimir.questions`, `mimir.answer`),
//! which unlocks nothing on a printer. A partner phone has the same rights, but never approves what
//! any partner app asked for.

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
/// The longest `approvals.list` waits for start cards' files to be read.
const LIST_HEAT_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
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
        let task = tokio::spawn(forward(
            b.clone(),
            sid,
            out,
            ctx.jobs.clone(),
            pairing.pairing_id.clone(),
        ));
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
    pairing_id: String,
) {
    let mut rx = b.hub.events.subscribe();
    // The approve right as it is now: turning it off in the app stops cards and questions at once.
    let approver = || {
        b.remote
            .pairing(&pairing_id)
            .is_some_and(|p| p.kind == PeerKind::Phone && p.rights.approve)
    };
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
            Some("approval") if approver() => {
                if let Some(id) = data.get("id").and_then(Value::as_str) {
                    // A start card says whether a phone could approve it, from its file read once.
                    read_card_heat(&b, id).await;
                }
                if let Some(id) = data.get("id").and_then(Value::as_str)
                    && decidable(&b, id)
                    && let Some(view) = card_view(&b, id)
                {
                    emit(&out, &sid, "approval.request", view);
                }
            }
            Some("approval.resolved") if approver() => {
                if let Some(r) = phone_resolved(&data) {
                    emit(&out, &sid, "approval.resolved", r);
                }
            }
            Some("remote.quota") => emit(&out, &sid, "remote.quota", data),
            Some("mimir.question") if approver() => emit(&out, &sid, "mimir.question", data),
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

#[allow(clippy::too_many_lines)] // One flat method table.
pub(crate) async fn handle(b: &Arc<Bridge>, ctx: &Arc<SessCtx>, method: &str, p: Value) -> Reply {
    let pairing = b
        .remote
        .pairing(&ctx.pairing_id)
        .ok_or_else(|| err("forbidden", "this device is no longer paired"))?;
    match method {
        "host.info" => host_info(b, &pairing),
        // A partner phone's open partner routes, with the relay routes to use (partner_route.rs).
        // The bytes themselves never come through here.
        "partnerRoute.list" => crate::partner_route::phone_list(b, &pairing).ok_or_else(|| {
            err(
                "not_supported",
                "partner routes are for a partner app's own phone",
            )
        }),
        "printers.list" => Ok(Value::Array(
            b.printers.lock().await.values().map(crate::rpc::listed).collect(),
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
        "approvals.list" => {
            // Files not read yet are read four at a time, for two seconds at most; a card still being
            // read lists with `heat_pending` and its read carries on.
            let pending = b.broker.as_ref().map(|br| br.pending()).unwrap_or_default();
            let ids: Vec<String> = pending
                .into_iter()
                .filter(|id| decidable(b, id))
                .take(200)
                .collect();
            let reads = futures::stream::iter(ids)
                .map(|id| {
                    let b = b.clone();
                    async move { read_card_heat(&b, &id).await }
                })
                .buffer_unordered(4)
                .collect::<Vec<()>>();
            let _ = tokio::time::timeout(LIST_HEAT_WAIT, reads).await;
            Ok(approvals_list(b, &pairing))
        }
        // The relay's numbers for this hub (tier, used, cap), as Settings shows them.
        "remote.quota" => Ok(b.remote.quota().unwrap_or(Value::Null)),
        "approvals.decide" => decide(b, ctx, &pairing, &p).await,
        "jobs.control" => control(b, ctx, &pairing, &p).await,
        "mimir.questions" => {
            approver_phone(&pairing)?;
            Ok(crate::app_link::mimir_state(b))
        }
        "mimir.answer" => mimir_answer(b, &pairing, &p).await,
        "plate.check" => plate_check(b, &pairing, &p).await,
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
        _ => partner_or_none(b, &pairing, method, &p).await,
    }
}

/// A partner phone's own push token, for its own pairing only (push.rs); nothing else is remote.
async fn partner_or_none(b: &Arc<Bridge>, pairing: &RemotePairing, method: &str, p: &Value) -> Reply {
    if matches!(method, "push.registerPartner" | "push.unregisterPartner") {
        return crate::push::remote_partner(b, pairing, method, p)
            .await
            .map_err(|e| from_rpc(&e));
    }
    Err(err(
        "not_supported",
        format!("{method} is not available over remote access"),
    ))
}

/// Only a paired phone with the approve right reads or answers mimir's questions.
fn approver_phone(pairing: &RemotePairing) -> Result<(), (&'static str, String)> {
    if pairing.kind == PeerKind::Phone && pairing.rights.approve {
        Ok(())
    } else {
        Err(err("forbidden", "this device may not answer mimir's questions"))
    }
}

/// The version of `mimir.answer` this hub reads (`MIMIR_QUESTION_V` in rpc.ts).
const MIMIR_ANSWER_V: u64 = 1;

/// A phone's answer to mimir's question, checked here and handed to the app, which takes the
/// first answer only. Not signed: it unlocks nothing on a printer; anything mimir does next asks
/// for its own approval. The audit line names the device, the question and the choice.
async fn mimir_answer(b: &Arc<Bridge>, pairing: &RemotePairing, p: &Value) -> Reply {
    approver_phone(pairing)?;
    if p.get("v").and_then(Value::as_u64) != Some(MIMIR_ANSWER_V) {
        return Err(err("bad_request", "this hub reads answers of version 1"));
    }
    let text = |key: &str, max: usize| {
        p.get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= max)
            .map(str::to_owned)
            .ok_or_else(|| err("bad_request", format!("{key} is required")))
    };
    let session_id = text("sessionId", 128)?;
    let ask_id = text("askId", 200)?;
    let choice_id = match p.get("choiceId") {
        Some(Value::Null) => Value::Null,
        Some(Value::String(s)) if !s.is_empty() && s.len() <= 64 => json!(s),
        _ => return Err(err("bad_request", "choiceId is a choice id or null")),
    };
    let device = pairing.peer.get("deviceId").cloned().unwrap_or(Value::Null);
    let name: String = pairing
        .peer
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Phone")
        .chars()
        .take(64)
        .collect();
    let answer = json!({ "sessionId": session_id, "askId": ask_id, "choiceId": choice_id });
    let phone = json!({ "deviceId": device, "name": name });
    match crate::app_link::phone_answer(b, &phone, answer).await {
        Ok(_) => {
            b.hub.audit(json!({
                "origin": "phone",
                "via": "relay",
                "action": "mimir.answer",
                "deviceId": device,
                "deviceName": name,
                "sessionId": session_id,
                "askId": ask_id,
                "choiceId": choice_id,
            }));
            Ok(json!({ "answered": true }))
        }
        Err(e) => Err(match e.code.as_str() {
            "not_found" => err(
                "not_found",
                "this question was already answered or is no longer waiting",
            ),
            "invalid_input" => err("bad_request", "that is not one of the question's answers"),
            "timeout" => err("timeout", e.message.chars().take(500).collect::<String>()),
            _ => err(
                "unavailable",
                format!(
                    "{} on this computer cannot take the answer now",
                    crate::app_name()
                ),
            ),
        }),
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
    // A partner phone's direct video counts against its daily allowance like its relay bytes.
    let meter = crate::remote::usage_key(pairing).map(|k| {
        let b = b.clone();
        Arc::new(move |n: usize| crate::remote::partner_spend(&b, &k, n)) as crate::remote_rtc::Meter
    });
    let started = crate::remote_rtc::start(b, printer, sdp, b.remote.stun(), meter, move |reason| {
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
    let mut info = json!({
        "identity": identity,
        "kind": "link",
        "slicing": [],
        "printers": true,
        "camera": true,
        // Partner phones register their own push token here; our phone does it through the app.
        "push": p.partner.is_some(),
        "mimir": true,
        // Starts under the remote start rule, with `plate.check` for the card's pictures. A partner
        // phone has it while it may approve.
        "remoteStart": p.partner.is_none() || p.rights.approve,
        "rights": {
            "request": p.rights.request,
            "approve": p.rights.approve && p.kind == PeerKind::Phone,
            "introduce": false,
        },
        // The STUN server direct video uses (our own, next to the relay), so the phone does not
        // need a third party's.
        "stun": b.remote.stun(),
    });
    if let (Some(name), Some(o)) = (&p.partner, info.as_object_mut()) {
        o.insert("partner".into(), json!(name));
    }
    Ok(info)
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
/// back to the app that raised them are answered in the app, and so is a connected app's call
/// (switching a Home Assistant device): a phone could only deny it, and a phone built before the
/// kind existed would show an Approve the hub then refuses.
fn decidable(b: &Bridge, id: &str) -> bool {
    shown_to_phones(b.agent_work.kind(id)) || b.hub.item_for_request(id).is_some()
}

/// Whether a card holding agent work of this kind goes to phones.
fn shown_to_phones(kind: Option<&str>) -> bool {
    kind.is_some_and(|k| k != "plugin")
}

/// What a phone may do with a card over the relay (`docs/safety.md`).
#[derive(Debug, PartialEq)]
enum Remote {
    /// Pausing, stopping, or skipping one object: it only stops extrusion.
    Stop,
    /// A start, under the remote start rule, of the file with this content hash. `key` names the
    /// start for the check right before it: the request id of an agent's print, or the queue item id.
    Start {
        printer: String,
        sha256: String,
        key: String,
    },
    /// Deny only.
    No,
}

/// Which kinds of held work a phone approves from afar without the start rule.
fn stops_only(kind: Option<&str>) -> bool {
    matches!(kind, Some("pause" | "cancel" | "skip"))
}

/// Cards a phone may approve over the relay: a stop, or a start under the remote start rule.
/// Scheduled plates start later with nobody looking, so a plate check now proves nothing: those,
/// and everything else, the phone may only deny.
fn approvable_remotely(b: &Bridge, id: &str) -> Remote {
    let kind = b.agent_work.kind(id);
    if stops_only(kind) {
        return Remote::Stop;
    }
    if let Some((printer, sha256)) = b.agent_work.print_file(id) {
        return Remote::Start {
            printer,
            sha256,
            key: id.to_owned(),
        };
    }
    if kind.is_none()
        && let Some(item) = b.hub.item_for_request(id)
        && item.start_after_ms.is_none()
    {
        return Remote::Start {
            printer: item.printer_id,
            sha256: item.sha256,
            key: item.id,
        };
    }
    Remote::No
}

/// Reads what a start card's file heats, once per file, so the card and the decision can say.
async fn read_card_heat(b: &Arc<Bridge>, id: &str) {
    if let Remote::Start { sha256, printer, .. } = approvable_remotely(b, id) {
        crate::remote_start::refresh_cap(b, &printer).await;
        let (b2, id2, sha2) = (b.clone(), id.to_owned(), sha256.clone());
        crate::remote_start::read_heat(b, &sha256, move || {
            b2.agent_work.print_data(&id2).or_else(|| b2.hub.job_data(&sha2))
        })
        .await;
    }
}

/// The card's word on a remote start: whether the rule could let a phone approve it once the plate
/// passes, and if not, why. `None` for a card that starts nothing.
fn remote_start_view(b: &Bridge, id: &str) -> Option<Value> {
    let Remote::Start { printer, sha256, .. } = approvable_remotely(b, id) else {
        return None;
    };
    let before = crate::remote_start::rule_before_plate(&crate::remote_start::facts(b, &printer, &sha256));
    let mut v = json!({
        "printerId": printer,
        "enabled": before.is_ok(),
        "plateWindowSeconds": crate::remote_start::PLATE_PASS.as_secs(),
    });
    if let (Err(why), Some(o)) = (before, v.as_object_mut()) {
        o.insert("reason".into(), json!(why.reason()));
        o.insert("message".into(), json!(why.message()));
    }
    Some(v)
}

/// Largest picture on a `plate.check` reply, as base64: two fit in one sealed message.
const PLATE_PICTURE_B64: usize = 340_000;

/// A picture for the card, shrunk to the remote width, or `None` when it will not fit.
async fn card_picture(s: crate::watch::Still) -> Option<Value> {
    let (ct, data) = (s.content_type.clone(), s.data);
    let small = tokio::task::spawn_blocking(move || {
        crate::h264::fit_jpeg(&data, crate::remote_cam::MAX_WIDTH, 70)
            .map_or((ct, data), |j| ("image/jpeg".to_owned(), j))
    })
    .await
    .ok()?;
    let b64 = STANDARD.encode(&small.1);
    (b64.len() <= PLATE_PICTURE_B64).then(|| json!({ "contentType": small.0, "dataB64": b64 }))
}

/// `plate.check {printerId}` (approver phones): runs the camera guard's plate check now and returns
/// the still beside the person's empty-plate picture, for a start card. Only on a printer with remote
/// start on. `passes` says whether the rule takes this look, until `passUntil`.
async fn plate_check(b: &Arc<Bridge>, pairing: &RemotePairing, p: &Value) -> Reply {
    if !(pairing.kind == PeerKind::Phone && pairing.rights.approve) {
        return Err(err("forbidden", "this device may not approve"));
    }
    let printer = printer_arg(p)?;
    known_printer(b, &printer).await?;
    if crate::remote_start::policy(b, &printer).is_none() {
        return Err(err("forbidden", crate::remote_start::Why::Off.message()));
    }
    if !crate::guard::on(b, &printer) {
        return Err(err("forbidden", crate::remote_start::Why::GuardOff.message()));
    }
    let look = crate::guard::look_now(b, &printer).await;
    let reference = crate::guard::reference(b, &printer);
    let ended = b.hub.bed(&printer).ended_at_ms;
    let pass = match &look {
        None => Err(crate::remote_start::Why::NoAnswer),
        Some(l) => crate::remote_start::plate_pass(Some(crate::remote_start::Look::from(l)), ended),
    };
    let taken_at = reference.as_ref().map(|r| r.captured_at_ms);
    let mut out = json!({
        "printerId": printer,
        "checked": look.is_some(),
        "passes": pass.is_ok(),
        "plateWindowSeconds": crate::remote_start::PLATE_PASS.as_secs(),
        "still": Value::Null,
        "reference": Value::Null,
    });
    let o = out.as_object_mut().ok_or_else(|| err("failed", "reply"))?;
    if let Err(why) = &pass {
        o.insert("reason".into(), json!(why.reason()));
        o.insert("message".into(), json!(why.message()));
    }
    if let Some(l) = look {
        o.insert("clear".into(), json!(l.clear));
        o.insert("compared".into(), json!(l.compared));
        o.insert("checkedAt".into(), json!(l.still.captured_at_ms));
        if pass.is_ok() {
            // A hint for the card's countdown on the phone's clock; the hub keeps its own.
            let left = crate::remote_start::PLATE_PASS.saturating_sub(l.taken.elapsed());
            o.insert(
                "passUntil".into(),
                json!(crate::hub::now_ms() + u64::try_from(left.as_millis()).unwrap_or(0)),
            );
        }
        o.insert("still".into(), card_picture(l.still).await.unwrap_or(Value::Null));
    }
    if let Some(r) = reference {
        o.insert("reference".into(), card_picture(r).await.unwrap_or(Value::Null));
        o.insert("referenceAt".into(), json!(taken_at));
    }
    Ok(out)
}

/// A card as a remote device gets it: the broker's request exactly as the phone signs it, and next
/// to it (not inside, so the signed hash is unchanged) the hub's checked summary of the work. The
/// phone recomputes each action's parameter hash from the summary and shows it only on a match.
fn card_view(b: &Bridge, id: &str) -> Option<Value> {
    let request = serde_json::to_value(b.broker.as_ref()?.request(id)?).ok()?;
    let mut view = json!({ "request": request, "source": "host" });
    if let (Some(work), Some(o)) = (b.agent_work.summary(id), view.as_object_mut()) {
        o.insert(work_key(&work).into(), work);
    }
    if let (Some(rs), Some(o)) = (remote_start_view(b, id), view.as_object_mut()) {
        o.insert("remoteStart".into(), rs);
    }
    if let (Some(name), Some(o)) = (lock(&b.card_partners).get(id).cloned(), view.as_object_mut()) {
        o.insert("partner".into(), json!(name));
    }
    Some(view)
}

/// Where a card's work summary goes in the view. A connected app's work and a home have their own keys:
/// a phone built before it knew those kinds checks `work` against a fixed list and would refuse the
/// whole approvals list over one card. Without `work`, such a phone shows the card with no Approve, as
/// for any card it cannot check; a phone never approves a home anyway (`approvable_remotely`).
fn work_key(summary: &Value) -> &'static str {
    match summary["kind"].as_str() {
        Some("plugin") => "connectedAppWork",
        // A skip, under its own key for the same reason.
        Some("skip") => "objectWork",
        Some("home") => "homeWork",
        _ => "work",
    }
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

/// Whether a phone may approve a card with this recorded raiser. Our phone may approve any card it is
/// shown. A partner phone never approves what a partner app raised, through any partner key or any
/// partner phone, decided by the raiser's role the hub recorded and never by a name.
fn phone_may_approve(partner_phone: bool, raiser: Option<&crate::rpc::CardRaiser>) -> bool {
    !partner_phone || !raiser.is_some_and(|r| r.role == crate::rpc::RaiserRole::Partner)
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

/// The remote start rule for an approval from afar: the rule on the look the person saw, then a
/// confirming look now, which must be answered and pass too. Returns both looks for the audit.
async fn remote_start_ok(
    b: &Arc<Bridge>,
    printer: &str,
    sha256: &str,
    bed_clear: bool,
) -> Result<(Value, Value), (&'static str, String)> {
    use crate::remote_start::{Why, facts, look_audit, rule};
    let fail = |w: Why| err(w.code(), w.message());
    crate::remote_start::refresh_cap(b, printer).await;
    rule(&facts(b, printer, sha256), bed_clear).map_err(fail)?;
    let seen = crate::guard::last_look(b, printer)
        .as_ref()
        .map_or(Value::Null, look_audit);
    // A confirming look nobody answered would leave the earlier look standing in for it.
    let now = crate::guard::look_now(b, printer)
        .await
        .ok_or_else(|| fail(Why::NoAnswer))?;
    rule(&facts(b, printer, sha256), bed_clear).map_err(fail)?;
    Ok((seen, look_audit(&now)))
}

#[allow(clippy::too_many_lines)] // Check, audit, then grant or deny, in the order a reviewer reads them.
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
    // A partner phone has our phone's rights, but never approves anything a partner app asked for,
    // through any partner key or partner phone, its own included. It may still deny it.
    if decision == "approve" && !phone_may_approve(pairing.partner.is_some(), lock(&b.card_raisers).get(&id))
    {
        return Err(err(
            "forbidden",
            format!(
                "a partner phone cannot approve what a partner app asked for; approve this in the {} app, on another phone or at the printer",
                crate::app_name()
            ),
        ));
    }
    // The person's plate answer, signed with the decision; a start from afar needs it and a pass.
    let bed_clear = p.get("bedClear").and_then(Value::as_bool) == Some(true);
    let mut remote_start = false;
    let mut looks = Value::Null;
    let mut start_key = None;
    if decision == "approve" {
        read_card_heat(b, &id).await;
        match approvable_remotely(b, &id) {
            Remote::Stop => {}
            Remote::Start { printer, sha256, key } => {
                let (seen, now) = remote_start_ok(b, &printer, &sha256, bed_clear).await?;
                looks = json!({ "seen": seen, "atApproval": now });
                remote_start = true;
                start_key = Some(key);
            }
            Remote::No => {
                return Err(err(
                    "not_supported",
                    format!(
                        "approve this in the {} app or at the printer; away from home a phone approves pausing, stopping or skipping an object, and a start only on a printer with remote start on",
                        crate::app_name()
                    ),
                ));
            }
        }
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
        "remoteStart": remote_start,
        "plateChecks": looks,
    }));
    if decision == "approve" {
        // The start is checked again right before its start command (remote_start::before_start).
        if let Some(key) = &start_key {
            crate::remote_start::approved(b, key);
        }
        // A bed answer given from afar is taken only for a start that passed the remote start rule,
        // where the camera checked the plate; otherwise nobody there can see it.
        let out = match crate::hub_rpc::grant(
            b,
            broker,
            &json!({ "requestId": id, "bedClear": remote_start, "remoteStart": remote_start }),
        )
        .await
        {
            Ok(o) => o,
            Err(e) => {
                if let Some(key) = &start_key {
                    crate::remote_start::forget(b, key);
                }
                return Err(from_rpc(&e));
            }
        };
        crate::hub_rpc::resolved(b, &id, true, "phone", None);
        if let Some((owner, work)) = b.agent_work.take(&id) {
            let token = serde_json::from_value(out).map_err(|_| err("failed", "the broker gave no token"))?;
            crate::agent_work::run(b, id.clone(), work, token, owner, remote_start);
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
    lock(&b.card_raisers).insert(
        request_id.clone(),
        crate::rpc::CardRaiser {
            role: if pairing.partner.is_some() {
                crate::rpc::RaiserRole::Partner
            } else if pairing.kind == PeerKind::Agent {
                crate::rpc::RaiserRole::Agent
            } else {
                crate::rpc::RaiserRole::Phone
            },
            id: Some(ctx.pairing_id.clone()),
        },
    );
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_partner_phone_never_approves_a_card_when_who_raised_it_is_unknown() {
        use crate::rpc::{CardRaiser, RaiserRole};
        let raiser = |role| CardRaiser { role, id: None };
        // No raiser on record: our phone may approve it, a partner phone may not.
        assert!(phone_may_approve(false, None));
        assert!(
            !phone_may_approve(true, None),
            "a partner phone approved a card with no recorded raiser"
        );
        for role in [RaiserRole::App, RaiserRole::Agent, RaiserRole::Phone] {
            assert!(phone_may_approve(true, Some(&raiser(role))), "{role:?}");
            assert!(phone_may_approve(false, Some(&raiser(role))), "{role:?}");
        }
        assert!(!phone_may_approve(true, Some(&raiser(RaiserRole::Partner))));
        assert!(phone_may_approve(false, Some(&raiser(RaiserRole::Partner))));
    }

    #[test]
    fn a_connected_app_card_stays_in_the_app() {
        assert!(!shown_to_phones(Some("plugin")));
        assert!(!shown_to_phones(None));
        for kind in ["print", "resume", "gcode", "adjust", "pause", "cancel"] {
            assert!(shown_to_phones(Some(kind)), "{kind}");
        }
    }

    #[test]
    fn a_skip_is_approved_remotely_and_a_start_only_under_the_rule() {
        // Skipping one object only stops extrusion for it, like pausing or stopping.
        for kind in ["pause", "cancel", "skip"] {
            assert!(stops_only(Some(kind)), "{kind}");
        }
        for kind in ["print", "resume", "gcode", "adjust", "plugin"] {
            assert!(!stops_only(Some(kind)), "{kind}");
        }
        assert!(!stops_only(None));
        assert_eq!(work_key(&json!({ "kind": "skip" })), "objectWork");
    }

    #[test]
    fn a_connected_app_card_keeps_its_work_away_from_older_phones() {
        assert_eq!(
            work_key(&json!({ "kind": "plugin", "pluginId": "home-assistant" })),
            "connectedAppWork"
        );
        for kind in ["print", "resume", "gcode", "adjust", "pause", "cancel"] {
            assert_eq!(work_key(&json!({ "kind": kind })), "work", "{kind}");
        }
        // A home card's work is a kind older phones do not know either; a phone only denies it.
        assert_eq!(
            work_key(&json!({ "kind": "home", "printerId": "bay-1" })),
            "homeWork"
        );
    }
}
