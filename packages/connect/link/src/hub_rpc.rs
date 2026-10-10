// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The hub's methods: the local Print call, bed state, the queue and scheduled starts, settings,
//! remembered clients, and the watcher that runs with no client connected. The rules themselves
//! (who approves, when to ask about the bed, when a standing approval holds) are in `sx-permit`.
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use sx_connect::{
    ApprovalToken, Capability, JobFile, JobKind, PrinterState, PrinterStatus, RemoteFile, StartOptions,
};
use sx_permit::{ApprovalBroker, Plate, StandingApproval, StartOrigin, StartRefusal};

use crate::hub::{
    HUB_FILE, HubFile, QueueItem, QueueState, SavedPrinter, SavedService, Send, Step, bed_json, card_for,
    decide, internal_request, iso, job_file, job_phase, lock, new_item, now_ms, parse_iso, sha256_hex,
    start_params, upload_params,
};
use crate::rpc::{Bridge, Rpc, RpcError, arg, session, str_arg, to_json};

/// How long a status read may take inside the watcher or before a start.
const STATUS_TIMEOUT: Duration = Duration::from_secs(10);

fn refusal(e: &StartRefusal) -> RpcError {
    RpcError::new(e.code(), e.to_string())
}

pub(crate) fn experimental_refusal(plugin: &str) -> RpcError {
    RpcError::new(
        "not_supported",
        format!(
            "The {plugin} connector is experimental and has not been tested on real hardware yet. To use it, switch on Try experimental connectors at the bottom of Settings, Connected apps (shown in Developer mode)."
        ),
    )
}

/// Plugin manifests with an `experimental` flag. Experimental ones are left out unless the
/// setting is on or the caller passes `includeExperimental`.
pub(crate) fn plugins(b: &Bridge, p: &Value) -> Value {
    let show_all =
        b.hub.experimental() || p.get("includeExperimental").and_then(Value::as_bool) == Some(true);
    Value::Array(
        sx_connect::all_manifests()
            .into_iter()
            .filter(|m| show_all || !sx_connect::is_experimental(&m.id))
            .map(|m| {
                let experimental = sx_connect::is_experimental(&m.id);
                let mut v = serde_json::to_value(m).unwrap_or(Value::Null);
                if let Some(o) = v.as_object_mut() {
                    o.insert("experimental".into(), json!(experimental));
                }
                v
            })
            .collect(),
    )
}

/// A file name the printer stores and a card shows as is: no folders, no `.` or `..`, and no
/// control characters (a line break could make a card read as two lines of facts).
pub(crate) fn file_name_ok(n: &str) -> bool {
    // Line and paragraph separators, zero-width marks and bidirectional overrides read as layout.
    let hidden = |c: char| {
        c.is_control()
            || matches!(c, '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    };
    !n.is_empty()
        && n.len() <= 255
        && n != "."
        && n != ".."
        && !n.chars().any(|c| c == '/' || c == '\\' || hidden(c))
}

/// `file: {name, kind, sha256, dataBase64}`, with the data checked against the declared SHA-256.
pub(crate) fn decode_file(p: &Value) -> Rpc<JobFile> {
    let file = p
        .get("file")
        .ok_or_else(|| RpcError::new("bad_request", "file is required"))?;
    let name = file
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| file_name_ok(n))
        .ok_or_else(|| {
            RpcError::new(
                "bad_request",
                "file.name is required: at most 255 bytes, no path separators or control characters",
            )
        })?;
    let kind: JobKind = serde_json::from_value(file.get("kind").cloned().unwrap_or(Value::Null))
        .map_err(|_| RpcError::new("bad_request", "file.kind is malformed"))?;
    let declared = file.get("sha256").and_then(Value::as_str).unwrap_or("");
    let data = B64
        .decode(file.get("dataBase64").and_then(Value::as_str).unwrap_or(""))
        .map_err(|_| RpcError::new("bad_request", "file.dataBase64 is not base64"))?;
    let actual = sha256_hex(&data);
    if !actual.eq_ignore_ascii_case(declared) {
        return Err(RpcError::new(
            "bad_request",
            "file.sha256 does not match the data",
        ));
    }
    Ok(JobFile {
        name: name.to_owned(),
        kind,
        data,
        sha256: actual,
    })
}

fn opts_arg(p: &Value) -> Rpc<StartOptions> {
    p.get("opts")
        .filter(|o| !o.is_null())
        .map(|o| serde_json::from_value(o.clone()))
        .transpose()
        .map_err(|_| RpcError::new("bad_request", "opts is malformed"))
        .map(Option::unwrap_or_default)
}

fn bool_arg(p: &Value, key: &str) -> bool {
    p.get(key).and_then(Value::as_bool) == Some(true)
}

// ---- saving ----

/// Writes `hub.json`: printers, fleets, services, settings, clients, bed records and the time.
pub(crate) async fn save(b: &Bridge) {
    let Some(dir) = &b.hub.dir else { return };
    let _guard = b.hub.save_lock.lock().await;
    let mut printers: Vec<SavedPrinter> = b
        .printers
        .lock()
        .await
        .values()
        .map(|r| SavedPrinter {
            config: r.config.clone(),
            info: r.info.clone(),
        })
        .collect();
    printers.sort_by(|a, c| a.config.id.cmp(&c.config.id));
    let fleets = b.fleets.lock().await.clone();
    let services = b
        .services
        .lock()
        .await
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                SavedService {
                    base_url: v.base_url.clone(),
                    secret_ref: v.secret_ref.clone(),
                },
            )
        })
        .collect();
    let file = HubFile {
        version: 1,
        printers,
        fleets,
        services,
        lan_port: *lock(&b.hub.lan_port),
        settings: lock(&b.hub.settings).clone(),
        clients: lock(&b.hub.clients).clone(),
        beds: lock(&b.hub.beds)
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        push: b.hub.push.regs(),
        upload_records: b.hub.uploads(),
        job_objects: b.hub.all_job_objects(),
        relative_left: b.hub.all_relative_left(),
        heartbeat_ms: now_ms(),
    };
    let body = match serde_json::to_vec_pretty(&file) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("sx-link: cannot encode the hub state: {e}");
            return;
        }
    };
    if let Err(e) = sx_connect::write_private(&dir.path().join(HUB_FILE), &body) {
        eprintln!("sx-link: cannot save the hub state: {e}");
    }
}

// ---- watching printers ----

/// Feeds one status reading to the printer's bed record and announces a change. A print the
/// printer started on its own gets the guard's plate check.
pub(crate) fn record(b: &Arc<Bridge>, id: &str, st: &PrinterStatus) {
    b.hub.note_observed(st);
    // The printer still shows the time before the hub's start: not an end, not a new job.
    if b.hub.stale_after_start(st) {
        return;
    }
    let phase = job_phase(st);
    let (changed, rec) = {
        let mut beds = lock(&b.hub.beds);
        let r = beds.entry(id.to_owned()).or_default();
        let before = (r.state, r.epoch);
        r.observe(phase, st.job_name.as_deref(), now_ms());
        ((r.state, r.epoch) != before, r.clone())
    };
    if changed {
        b.hub.emit("bed", bed_json(id, &rec));
        b.hub.mark_dirty();
    }
    let (alert, prev) = b.hub.alert(st);
    let running = matches!(st.state, PrinterState::Preparing | PrinterState::Printing);
    if running
        && matches!(
            prev,
            Some(PrinterState::Idle | PrinterState::Finished | PrinterState::Error)
        )
    {
        // The hub marks its own starts as printing when it makes them, so this is someone else's.
        tokio::spawn(crate::guard::job_began(b.clone(), id.to_owned()));
    }
    crate::guard::observed(b, id, prev, st.state);
    if let Some(kind) = alert {
        let mut data = serde_json::Map::new();
        data.insert("printerId".into(), json!(id));
        data.insert("kind".into(), json!(kind));
        data.insert("at".into(), json!(iso(now_ms())));
        if let Some(j) = &st.job_name {
            data.insert("jobName".into(), json!(j));
        }
        if let Some(m) = &st.message {
            data.insert("message".into(), json!(m));
        }
        b.hub.emit("alert", Value::Object(data));
        crate::push::alert(b, kind, Some(id), None);
    }
}

/// Reads a printer's status and records it. `None` when it did not answer.
pub(crate) async fn observe(b: &Arc<Bridge>, id: &str) -> Option<PrinterStatus> {
    let read = async { session(b, id).await.ok()?.status().await.ok() };
    let st = tokio::time::timeout(STATUS_TIMEOUT, read).await.ok().flatten()?;
    record(b, id, &st);
    Some(st)
}

/// The watcher: every `watch_every`, read every printer, run the queue, and save what changed.
/// Runs for the life of the bridge, whether or not a client is connected.
pub(crate) async fn watch(b: Arc<Bridge>) {
    let mut tick = tokio::time::interval(b.hub.watch_every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let ids: Vec<String> = b.printers.lock().await.keys().cloned().collect();
        futures::future::join_all(ids.iter().map(|id| observe(&b, id))).await;
        run_queue(&b).await;
        crate::watch::heater_steps(&b).await;
        if b.hub.prune(now_ms()) {
            b.hub.save_queue();
        }
        if b.hub.take_dirty() | b.hub.push.take_changed() || b.hub.heartbeat_due() {
            save(&b).await;
        }
    }
}

// ---- starting a plate ----

/// Uploads and starts one plate under tokens the hub mints itself, after the start rules allow it.
/// Used by the local Print call and by queued and scheduled starts.
async fn start_plate(b: &Arc<Bridge>, s: Send<'_>, bed_confirmed: bool) -> Rpc<RemoteFile> {
    let broker = b
        .broker
        .clone()
        .ok_or_else(|| RpcError::new("not_supported", "this bridge has no approval broker"))?;
    if !b.hub.begin_start(s.printer) {
        return Err(RpcError::new(
            "busy",
            "another start on this printer is in progress",
        ));
    }
    let held = b.hub.printer_lock(s.printer);
    let guard = held.lock().await;
    let out = start_plate_inner(b, &broker, &s, bed_confirmed).await;
    drop(guard);
    b.hub.end_start(s.printer);
    save(b).await;
    out
}

async fn start_plate_inner(
    b: &Arc<Bridge>,
    broker: &ApprovalBroker,
    s: &Send<'_>,
    bed_confirmed: bool,
) -> Rpc<RemoteFile> {
    observe(b, s.printer)
        .await
        .filter(|st| st.state != PrinterState::Offline)
        .ok_or_else(|| RpcError::new("unreachable", "the printer did not answer"))?;
    let bed = b.hub.bed(s.printer);
    sx_permit::check_start(Some(s.origin), bed.state, s.origin.is_remote(), bed_confirmed)
        .map_err(|e| refusal(&e))?;
    let session = session(b, s.printer).await?;
    // A connector that rewrites files (BamBuddy stamps a non-Bambu profile) does it before the
    // token exists, so the hash that is approved is the hash of the bytes the upload posts.
    let file = if session.capabilities().contains(&Capability::RewritesUpload) {
        session.prepare_upload(job_file(s)).await?
    } else {
        job_file(s)
    };
    let size = u64::try_from(file.data.len()).unwrap_or(u64::MAX);
    let sha = file.sha256.clone();
    let mint = |action: &str, params: &Value| {
        broker
            .mint(
                internal_request(s.origin, s.printer, action, params, s.title),
                bed_confirmed,
            )
            .map_err(|e| RpcError::new("approval_invalid", e.to_string()))
    };
    let t = mint("printer.upload", &upload_params(s.printer, s.name, &sha))?;
    let rf = session.upload(file, &to_connect(&t)).await?;
    record_upload(b, &rf, size).await;
    let t = mint("printer.start", &start_params(s.printer, &rf, &s.opts))?;
    crate::device::settle_absolute(b, s.printer, session.as_ref()).await?;
    session.start(&rf, s.opts.clone(), &to_connect(&t)).await?;
    if session.reports_start_late() {
        b.hub.note_start_pending(s.printer);
    }
    started(b, s.printer, &rf.name);
    Ok(rf)
}

fn to_connect(t: &sx_permit::ApprovalToken) -> ApprovalToken {
    ApprovalToken {
        request_id: t.request_id.clone(),
        token: t.token.clone(),
        expires_at: t.expires_at.clone(),
    }
}

pub(crate) fn started(b: &Bridge, printer: &str, job: &str) {
    let rec = {
        let mut beds = lock(&b.hub.beds);
        let r = beds.entry(printer.to_owned()).or_default();
        r.started(job, now_ms());
        r.clone()
    };
    // A new job: the objects of the last one no longer apply. `print.local` and `start` set the
    // new job's objects right after, when the app sent them.
    b.hub.set_job_objects(printer, None);
    b.hub.note_started(printer);
    b.hub.emit("bed", bed_json(printer, &rec));
}

/// Records that the person said the plate is clear.
fn confirm(b: &Bridge, printer: &str) -> Rpc<sx_permit::BedRecord> {
    let rec = {
        let mut beds = lock(&b.hub.beds);
        let r = beds.entry(printer.to_owned()).or_default();
        r.confirm_clear(now_ms())
            .map_err(|e| RpcError::new("busy", e.to_string()))?;
        r.clone()
    };
    b.hub.emit("bed", bed_json(printer, &rec));
    Ok(rec)
}

async fn known_printer(b: &Bridge, id: &str) -> Rpc<String> {
    b.printers
        .lock()
        .await
        .get(id)
        .map(|r| {
            r.info
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_owned()
        })
        .ok_or_else(|| RpcError::new("not_found", format!("no printer {id}")))
}

/// `print.local`: the person pressed Print in the app's Print sheet. One call uploads and starts.
/// No approval card: the click is the approval. The bed question is needed only when the bed is not
/// known to be clear; the sheet then asks and calls again with `bedClear: true`.
pub(crate) async fn print_local(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = str_arg(p, "printerId")?;
    known_printer(b, &printer).await?;
    let file = decode_file(p)?;
    let opts = opts_arg(p)?;
    let objects = crate::device::plate_objects_arg(p)?;
    let title = format!("Print {}", file.name);
    crate::guard::before_start(b, &printer, bool_arg(p, "plateOk")).await?;
    let rf = start_plate(
        b,
        Send {
            printer: &printer,
            name: &file.name,
            kind: file.kind,
            data: file.data.clone(),
            sha256: &file.sha256,
            opts,
            origin: StartOrigin::LocalClick,
            title: &title,
        },
        bool_arg(p, "bedClear"),
    )
    .await?;
    crate::device::keep_plate_objects(b, &printer, &rf.name, objects).await;
    Ok(json!({ "file": rf, "started": true, "bed": bed_json(&printer, &b.hub.bed(&printer)) }))
}

/// `start` with a token from an approval card (Pilot, MCP, a phone, the inbox). The card must have
/// asked about the bed (`approvals.grant` with `bedClear: true`). A bridge without a broker (tests,
/// the demo) takes `bedClear` on the call itself.
pub(crate) async fn start_with_token(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let file: RemoteFile = arg(p, "file")?;
    let held = b.hub.printer_lock(&file.printer_id);
    let _held = held.lock().await;
    start_with_token_held(b, p).await
}

/// `start_with_token` for a caller that already holds the printer's lock (agent work uploads and
/// starts under one hold).
pub(crate) async fn start_with_token_held(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let mut file: RemoteFile = arg(p, "file")?;
    let objects = crate::device::plate_objects_arg(p)?;
    crate::guard::before_start(b, &file.printer_id, bool_arg(p, "plateOk")).await?;
    // Hold the printer first: uploads wait while a start is in flight (`upload` refuses with busy),
    // so the hash read below is the content the printer starts.
    if !b.hub.begin_start(&file.printer_id) {
        return Err(RpcError::new(
            "busy",
            "another start on this printer is in progress",
        ));
    }
    let out = start_held(b, p, &mut file).await;
    b.hub.end_start(&file.printer_id);
    if out.is_ok() {
        crate::device::keep_plate_objects(b, &file.printer_id, &file.name, objects).await;
    }
    save(b).await;
    out?;
    if let Some(i) = &b.inbox {
        i.started(b, &file.printer_id, &file.name).await;
    }
    Ok(json!({ "ok": true }))
}

/// The rest of `start_with_token`, with the printer held.
async fn start_held(b: &Arc<Bridge>, p: &Value, file: &mut RemoteFile) -> Rpc<()> {
    // The content hash comes from this hub's own upload record, never from the caller, so the token
    // (which binds the hash the card showed) covers the file actually at that path.
    file.sha256 = verified_sha(b, &file.printer_id, &file.path, false).await;
    let opts = opts_arg(p)?;
    let token: ApprovalToken = arg(p, "token")?;
    let (origin, via_card, confirmed) = match &b.broker {
        Some(br) => {
            // The whole token is checked (signature, expiry, printer, file, options, not used yet)
            // before any state changes, without using it up; the driver's own check consumes it.
            let params = sx_permit::hash_params(&start_params(&file.printer_id, file, &opts));
            if let Err(e) = br.check(&to_permit(&token), "printer.start", &file.printer_id, &params) {
                // A valid token for this printer whose card bound a hash the hub cannot vouch for:
                // for an AI's card, say what to do instead of a bare mismatch. A token for another
                // printer stays a plain refusal.
                let ai = br.grant_info(&token.request_id).is_some_and(|i| {
                    i.origin.is_some_and(StartOrigin::is_ai)
                        && i.printer_id.as_deref() == Some(file.printer_id.as_str())
                });
                if ai && file.sha256.is_none() && matches!(e, sx_permit::Error::Mismatch { .. }) {
                    return Err(unverified_ai_start());
                }
                return Err(RpcError::new("approval_invalid", e.to_string()));
            }
            match br.grant_info(&token.request_id) {
                Some(i) => (
                    i.origin,
                    i.origin != Some(StartOrigin::LocalClick),
                    i.bed_confirmed,
                ),
                None => {
                    return Err(RpcError::new(
                        "approval_invalid",
                        "the approval is unknown, still waiting for an answer, denied or expired",
                    ));
                }
            }
        }
        None => (None, true, bool_arg(p, "bedClear")),
    };
    let printer = file.printer_id.clone();
    async {
        let _ = observe(b, &printer).await;
        let bed = b.hub.bed(&printer);
        // Cards that start a print are answered by a person in the app or on a phone (roles.rs), so
        // the card's bed answer is a person's. It stands behind this start only; the bed record is
        // not set from it, so a refused or failed start leaves the record as it was.
        sx_permit::check_start(origin, bed.state, via_card, confirmed).map_err(|e| refusal(&e))?;
        // A start an AI asked for (mimir or an outside agent) needs content this hub can vouch for;
        // a file put on the printer some other way (USB, the printer's screen, another app) cannot
        // be checked here. A person's own start of such a file is `files.start`, which asks them.
        if origin.is_some_and(StartOrigin::is_ai) && file.sha256.is_none() {
            return Err(unverified_ai_start());
        }
        let sess = session(b, &printer).await?;
        crate::device::settle_absolute(b, &printer, sess.as_ref()).await?;
        sess.start(file, opts, &token).await?;
        if sess.reports_start_late() {
            b.hub.note_start_pending(&printer);
        }
        started(b, &printer, &file.name);
        Ok::<_, RpcError>(())
    }
    .await
}

/// The refusal for a start an AI asked for of a file this hub did not upload and check.
fn unverified_ai_start() -> RpcError {
    RpcError::new(
        "unverified_file",
        "SlicerX did not upload this file, so it cannot check what is in it. Upload the file through SlicerX, then start it.",
    )
}

/// Records a file the hub uploaded, with the size and time the printer reports for it now.
pub(crate) async fn record_upload(b: &Arc<Bridge>, rf: &RemoteFile, size: u64) {
    let modified = match session(b, &rf.printer_id).await {
        Ok(s) => s
            .file_info(&rf.path)
            .await
            .ok()
            .flatten()
            .and_then(|i| i.modified),
        Err(_) => None,
    };
    b.hub.note_upload(rf, size, modified);
}

/// The content hash of the file at `path` if this hub uploaded it and the printer still reports the
/// same size and time; `None` (unverified) when the file changed or the hub never put it there.
/// Printers that report nothing about their files keep the recorded hash, unless `strict` (a start of
/// a stored file from the printer's list), where such a file reads as unverified.
pub(crate) async fn verified_sha(b: &Arc<Bridge>, printer: &str, path: &str, strict: bool) -> Option<String> {
    let rec = b.hub.upload_record(printer, path)?;
    let info = match session(b, printer).await {
        Ok(s) => s.file_info(path).await,
        Err(_) => return None,
    };
    match info {
        Ok(None) => (!strict).then_some(rec.sha256),
        Ok(Some(i)) => {
            let same_time = match (rec.modified, i.modified) {
                (Some(a), Some(z)) => (a - z).abs() < 0.001,
                _ => true,
            };
            (i.size == rec.size && same_time).then_some(rec.sha256)
        }
        // A file the printer no longer lists, or a printer that refused to say: unverified.
        Err(_) => None,
    }
}

fn to_permit(t: &ApprovalToken) -> sx_permit::ApprovalToken {
    sx_permit::ApprovalToken {
        request_id: t.request_id.clone(),
        token: t.token.clone(),
        expires_at: t.expires_at.clone(),
    }
}

// ---- bed ----

/// `bed.state {printerId}` and `bed.confirmClear {printerId}`.
pub(crate) async fn bed_call(b: &Arc<Bridge>, method: &str, p: &Value) -> Rpc<Value> {
    let printer = str_arg(p, "printerId")?;
    known_printer(b, &printer).await?;
    let _ = observe(b, &printer).await;
    match method {
        "bed.state" => Ok(bed_json(&printer, &b.hub.bed(&printer))),
        "bed.confirmClear" => {
            let rec = confirm(b, &printer)?;
            save(b).await;
            // An approved queued or scheduled plate may be waiting for exactly this.
            run_queue(b).await;
            Ok(bed_json(&printer, &rec))
        }
        other => Err(RpcError::new("bad_request", format!("unknown method {other}"))),
    }
}

// ---- approvals for queue cards ----

/// `approvals.grant {requestId, bedClear?}`. A card the hub raised for a queued or scheduled plate
/// becomes a standing approval the hub keeps; the token is not returned, since only the hub starts
/// the plate. Any other card returns its token as before, with the bed answer recorded.
pub(crate) async fn grant(b: &Arc<Bridge>, broker: &ApprovalBroker, p: &Value) -> Rpc<Value> {
    let id = str_arg(p, "requestId")?;
    let bed_clear = bool_arg(p, "bedClear");
    let Some(item) = b.hub.item_for_request(&id) else {
        return to_json(&broker.grant_with(&id, bed_clear).map_err(|e| grant_error(&e))?);
    };
    if !bed_clear {
        return Err(RpcError::new(
            "bed_check",
            "a queued or scheduled start needs the build plate confirmed clear on the card",
        ));
    }
    let now = now_ms();
    // The card's answer is kept on the standing approval, which lets it go stale; the printer's bed
    // record is not set from it.
    let bed = b.hub.bed(&item.printer_id);
    let opts_hash = item.opts_hash();
    let plate = Plate {
        printer_id: &item.printer_id,
        file_name: &item.name,
        sha256: &item.sha256,
        opts_hash: &opts_hash,
    };
    let origin = if item.start_after_ms.is_some() {
        StartOrigin::Schedule
    } else {
        StartOrigin::Queue
    };
    let standing = StandingApproval::new(&id, origin, plate, item.start_after_ms, now, &bed, true)
        .map_err(|e| RpcError::new("bad_request", e.to_string()))?;
    broker.grant_with(&id, true).map_err(|e| grant_error(&e))?;
    let (not_before, until) = (standing.not_before_ms, standing.expires_at_ms);
    let updated = b.hub.update_item(&item.id, |i| {
        i.approval = Some(standing);
        i.request_id = None;
        i.state = QueueState::Approved;
        i.message = None;
    });
    if let Some(u) = &updated {
        b.hub.emit("queue", u.to_json());
    }
    b.hub.emit("bed", bed_json(&item.printer_id, &bed));
    b.hub.save_queue();
    save(b).await;
    run_queue(b).await;
    Ok(json!({
        "queued": true,
        "itemId": item.id,
        "notBefore": iso(not_before),
        "approvedUntil": iso(until),
    }))
}

fn grant_error(e: &sx_permit::Error) -> RpcError {
    match e {
        sx_permit::Error::Expired => RpcError::new("expired", "the card expired before it was answered"),
        other => RpcError::new("bad_request", other.to_string()),
    }
}

/// A card for a queued or scheduled plate was declined: the plate leaves the queue.
pub(crate) fn declined(b: &Bridge, request_id: &str) {
    if let Some(item) = b.hub.item_for_request(request_id)
        && let Some(done) = b.hub.finish_item(
            &item.id,
            QueueState::Canceled,
            Some("declined on the card".into()),
        )
    {
        b.hub.emit("queue", done.to_json());
        b.hub.save_queue();
    }
}

/// A card was answered: `approval.resolved {requestId, decision, via, by?}` to the app, so a card
/// it still shows closes when a phone, a partner app or the agent that raised it answered first.
/// `via` is `app`, `phone`, `partner` or `agent`; `by` is a partner's name, from its key.
pub(crate) fn resolved(b: &Bridge, request_id: &str, granted: bool, via: &str, by: Option<&str>) {
    let mut data = json!({
        "requestId": request_id,
        "decision": if granted { "granted" } else { "denied" },
        "via": via,
    });
    if let (Some(by), Some(o)) = (by, data.as_object_mut()) {
        o.insert("by".into(), json!(by));
    }
    b.hub.emit("approval.resolved", data);
}

// ---- the queue ----

async fn raise_card(b: &Arc<Bridge>, item: &QueueItem, now: u64) {
    let Some(broker) = &b.broker else { return };
    let name = known_printer(b, &item.printer_id)
        .await
        .unwrap_or_else(|_| item.printer_id.clone());
    let card = card_for(item, &name, now);
    if broker.register(card.clone()).is_err() {
        return;
    }
    if let Some(u) = b.hub.update_item(&item.id, |i| {
        i.request_id = Some(card.id.clone());
        i.state = QueueState::AwaitingApproval;
        i.message = None;
    }) {
        b.hub
            .emit("approval", serde_json::to_value(&card).unwrap_or(Value::Null));
        b.hub.emit(
            "alert",
            json!({ "printerId": item.printer_id, "kind": "approval_waiting", "requestId": card.id, "at": iso(now_ms()) }),
        );
        crate::push::alert(b, "approval_waiting", Some(&item.printer_id), Some(&card.id));
        b.hub.emit("queue", u.to_json());
    }
}

async fn start_item(b: &Arc<Bridge>, item: &QueueItem) {
    let fail = |msg: &str| {
        if let Some(done) = b
            .hub
            .finish_item(&item.id, QueueState::Failed, Some(msg.to_owned()))
        {
            b.hub.emit("queue", done.to_json());
        }
    };
    let Some(approval) = &item.approval else { return };
    let Some(data) = b.hub.job_data(&item.sha256) else {
        return fail("the stored file is missing");
    };
    if sha256_hex(&data) != item.sha256 {
        return fail("the stored file changed after it was approved");
    }
    // An unattended start never goes onto a dirty plate; the guard's card says what it saw.
    if let Err(e) = crate::guard::before_start(b, &item.printer_id, false).await {
        return fail(&e.message);
    }
    let title = format!("{} {}", approval.origin.as_str(), item.name);
    let res = start_plate(
        b,
        Send {
            printer: &item.printer_id,
            name: &item.name,
            kind: item.kind,
            data,
            sha256: &item.sha256,
            opts: item.opts.clone(),
            origin: approval.origin,
            title: &title,
        },
        true,
    )
    .await;
    match res {
        Ok(_) => {
            if let Some(done) = b.hub.finish_item(&item.id, QueueState::Started, None) {
                b.hub.emit("queue", done.to_json());
            }
        }
        // Someone else is starting this printer right now; the next round sees the result.
        Err(e) if e.code == "busy" => {}
        Err(e) => fail(&e.message),
    }
}

/// One round of the queue: start what may start, raise cards, end what lapsed.
pub(crate) async fn run_queue(b: &Arc<Bridge>) {
    let _round = b.hub.run_lock.lock().await;
    let now = now_ms();
    let items: Vec<QueueItem> = lock(&b.hub.queue)
        .iter()
        .filter(|i| {
            !matches!(
                i.state,
                QueueState::Started | QueueState::Expired | QueueState::Canceled | QueueState::Failed
            )
        })
        .cloned()
        .collect();
    let mut first_seen: HashSet<String> = HashSet::new();
    let mut started_on: HashSet<String> = HashSet::new();
    let mut changed = false;
    for item in items {
        if started_on.contains(&item.printer_id) {
            continue;
        }
        let bed = b.hub.bed(&item.printer_id);
        let first = item.start_after_ms.is_none() && first_seen.insert(item.printer_id.clone());
        match decide(&item, &bed, first, now) {
            Step::Nothing => {}
            Step::Set(state, msg) => {
                if item.state != state || item.message.as_deref() != msg {
                    if let Some(u) = b.hub.update_item(&item.id, |i| {
                        i.state = state;
                        i.message = msg.map(str::to_owned);
                        if state == QueueState::Waiting {
                            i.approval = None;
                            i.request_id = None;
                        }
                    }) {
                        b.hub.emit("queue", u.to_json());
                    }
                    changed = true;
                }
            }
            Step::End(state, msg) => {
                if let Some(rid) = &item.request_id
                    && let Some(br) = &b.broker
                {
                    let _ = br.deny(rid);
                }
                if let Some(done) = b.hub.finish_item(&item.id, state, Some(msg.to_owned())) {
                    b.hub.emit("queue", done.to_json());
                }
                changed = true;
            }
            Step::Card => {
                raise_card(b, &item, now).await;
                changed = true;
            }
            Step::Start => {
                started_on.insert(item.printer_id.clone());
                start_item(b, &item).await;
                changed = true;
            }
        }
    }
    if changed {
        b.hub.save_queue();
    }
}

/// `queue.add`, `queue.list`, `queue.remove`.
pub(crate) async fn queue_call(b: &Arc<Bridge>, method: &str, p: &Value) -> Rpc<Value> {
    match method {
        "queue.list" => Ok(Value::Array(
            lock(&b.hub.queue).iter().map(QueueItem::to_json).collect(),
        )),
        "queue.add" => {
            if b.broker.is_none() {
                return Err(RpcError::new(
                    "not_supported",
                    "this bridge has no approval broker",
                ));
            }
            let printer = str_arg(p, "printerId")?;
            known_printer(b, &printer).await?;
            // Queued as given, without connecting: a printer may be off until the item's turn. A
            // connector that rewrites files prepares them when the item starts (start_plate_inner).
            let file = decode_file(p)?;
            let opts = opts_arg(p)?;
            let start_after =
                match (p.get("startAfter"), p.get("startAfterMs")) {
                    (Some(Value::String(s)), _) => Some(parse_iso(s).ok_or_else(|| {
                        RpcError::new("bad_request", "startAfter is not an ISO time in UTC")
                    })?),
                    (_, Some(v)) if !v.is_null() => Some(
                        v.as_u64()
                            .ok_or_else(|| RpcError::new("bad_request", "startAfterMs is malformed"))?,
                    ),
                    _ => None,
                };
            let title = p.get("title").and_then(Value::as_str).map(str::to_owned);
            let now = now_ms();
            let item = new_item(
                &printer,
                &file.name,
                file.kind,
                &file.sha256,
                u64::try_from(file.data.len()).unwrap_or(u64::MAX),
                opts,
                start_after,
                title,
                now,
            )
            .map_err(|m| RpcError::new("bad_request", m))?;
            b.hub
                .add_item(item.clone(), &file.data)
                .map_err(|m| RpcError::new("bad_request", m))?;
            // A scheduled start is approved now, at schedule time; a queued one when its turn comes.
            if item.start_after_ms.is_some() {
                raise_card(b, &item, now).await;
            }
            b.hub.save_queue();
            let item = b.hub.item(&item.id).unwrap_or(item);
            b.hub.emit("queue", item.to_json());
            let request = item
                .request_id
                .as_deref()
                .and_then(|r| b.broker.as_ref()?.request(r));
            let mut out = serde_json::Map::new();
            out.insert("item".into(), item.to_json());
            if let Some(r) = request {
                out.insert("request".into(), serde_json::to_value(r).unwrap_or(Value::Null));
            }
            Ok(Value::Object(out))
        }
        "queue.remove" => {
            let id = str_arg(p, "id")?;
            let item = b
                .hub
                .remove_item(&id)
                .ok_or_else(|| RpcError::new("not_found", format!("no queue item {id}")))?;
            if let (Some(rid), Some(br)) = (&item.request_id, &b.broker) {
                let _ = br.deny(rid);
            }
            b.hub.save_queue();
            b.hub.emit("queue", json!({ "id": id, "removed": true }));
            Ok(json!({ "removed": true }))
        }
        other => Err(RpcError::new("bad_request", format!("unknown method {other}"))),
    }
}

// ---- settings and clients ----

pub(crate) async fn settings_call(b: &Arc<Bridge>, method: &str, p: &Value) -> Rpc<Value> {
    match method {
        "settings.get" => to_json(&*lock(&b.hub.settings)),
        "settings.set" => {
            if let Some(v) = p.get("experimentalConnectors") {
                let on = v
                    .as_bool()
                    .ok_or_else(|| RpcError::new("bad_request", "experimentalConnectors is true or false"))?;
                lock(&b.hub.settings).experimental_connectors = on;
            }
            save(b).await;
            to_json(&*lock(&b.hub.settings))
        }
        other => Err(RpcError::new("bad_request", format!("unknown method {other}"))),
    }
}

pub(crate) async fn clients_call(b: &Arc<Bridge>, method: &str, p: &Value) -> Rpc<Value> {
    match method {
        // A key for an AI agent, a partner app or a detector the person connects from the app
        // ("Connect your AI agent"). Shown once in the reply; only its hash is kept.
        "clients.create" => {
            let name = str_arg(p, "name")?;
            if name.trim().is_empty() || name.chars().count() > 80 {
                return Err(RpcError::new("bad_request", "name is 1 to 80 characters"));
            }
            let role = match p.get("role").and_then(Value::as_str) {
                Some("agent") => crate::roles::Role::Agent,
                Some("watch") => crate::roles::Role::Watch,
                _ => return Err(RpcError::new("bad_request", "role is agent or watch")),
            };
            let remote = p.get("remote").and_then(Value::as_bool) == Some(true);
            if remote && role != crate::roles::Role::Agent {
                return Err(RpcError::new(
                    "bad_request",
                    "only an agent key works over remote access",
                ));
            }
            // A partner app is an agent with less (roles.rs), never a detector.
            let partner = p.get("partner").and_then(Value::as_bool) == Some(true);
            if partner && role != crate::roles::Role::Agent {
                return Err(RpcError::new(
                    "bad_request",
                    "a partner app key has the agent role",
                ));
            }
            let (key, id) = if partner {
                b.hub
                    .remember_partner(name.trim())
                    .map_err(|e| RpcError::new("failed", e))?
            } else {
                b.hub.remember_client(name.trim(), role)
            };
            b.hub.audit(json!({ "origin": "local_click", "action": "clients.create", "clientId": id, "role": role.as_str(), "partner": partner, "remote": remote }));
            // A remote agent also gets a pairing the hub answers on the relay, revoked with the key.
            let remote_access = if remote {
                Some(crate::remote::create_agent(b, &id, name.trim())?)
            } else {
                None
            };
            save(b).await;
            // A remote agent gets only its relay pairing: the control socket key would give it the
            // full agent role on this machine, which a hosted provider has no use for.
            let mut out = json!({ "clientId": id, "role": role.as_str() });
            if partner && let Some(o) = out.as_object_mut() {
                o.insert("partner".into(), json!(true));
            }
            if let Some(o) = out.as_object_mut() {
                match remote_access {
                    Some(r) => o.insert("remote".into(), r),
                    None => o.insert("clientKey".into(), json!(key)),
                };
            }
            Ok(out)
        }
        "clients.list" => Ok(Value::Array(
            lock(&b.hub.clients)
                .iter()
                .map(|c| {
                    json!({
                        "id": c.id, "name": c.name, "role": c.role.as_str(), "partner": c.partner,
                        "createdAt": iso(c.created_at_ms),
                        // A partner key nobody has used yet was never seen.
                        "lastSeenAt": (c.last_seen_ms > 0).then(|| iso(c.last_seen_ms)),
                    })
                })
                .collect(),
        )),
        "clients.revoke" => {
            let id = str_arg(p, "clientId")?;
            let removed = {
                let mut c = lock(&b.hub.clients);
                let before = c.len();
                c.retain(|x| x.id != id);
                before != c.len()
            };
            if !removed {
                return Err(RpcError::new("not_found", format!("no client {id}")));
            }
            // Close its live connections now, not at its next reconnect. Just after this reply, so a
            // client that revokes its own key still hears that it worked.
            let closing: Vec<_> = lock(&b.live_clients)
                .iter()
                .filter(|(c, _)| *c == id)
                .map(|(_, tx)| tx.clone())
                .collect();
            lock(&b.live_clients).retain(|(c, _)| *c != id);
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                for tx in closing {
                    let _ = tx.send(tokio_tungstenite::tungstenite::Message::Close(None));
                }
            });
            crate::remote::revoke_client(b, &id);
            b.hub
                .audit(json!({ "origin": "local_click", "action": "clients.revoke", "clientId": id }));
            save(b).await;
            Ok(json!({ "revoked": true }))
        }
        other => Err(RpcError::new("bad_request", format!("unknown method {other}"))),
    }
}
