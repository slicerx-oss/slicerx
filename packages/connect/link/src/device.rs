// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The device page's methods: the printer's file list, print history, reported problems, the
//! objects of the running print, and the three that act: `jog`, `objects.skip` and `files.start`.
//!
//! Reading is open to every role. Acting is app role only (roles.rs), never over the relay, and
//! each act goes through the same token gate as everything else: the hub mints a token for the
//! exact command (a person's click in the app is the approval, as with `print.local`) and the
//! driver checks it before anything is sent.
//!
//! `jog` moves the head by a small relative step, only while the printer is idle. A distance or feed
//! outside the limits is refused with the allowed range, never clamped, so what moves is what the
//! button said. Where the printer reports homed axes and the head position, an unhomed axis and a
//! move past the axis range are refused; where it does not report the position, Z only moves up.
//! `objects.skip` only while a print is running, and only in the job the person was looking at (the
//! bed epoch it read). `files.start` follows `print.local`'s bed rule, and a file this hub did not
//! upload, or one the printer cannot describe, reads as unverified: the call refuses until it is
//! repeated with `unverifiedOk: true`, which the app sends only after the person confirmed.
//!
//! Lists are capped and cleaned before they leave the hub: the newest 1000 files, 200 history
//! records, 256 objects of at most 64 outline points, and no names with hidden characters.
use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Value, json};
use sx_connect::{
    ApprovalToken, ErrorCode, JogAxis, Motion, PrintObject, PrintRecord, PrinterSession, PrinterState,
    RemoteFile, StartOptions, StoredFile,
};
use sx_permit::StartOrigin;

use crate::hub::JobObjects;
use crate::hub::{internal_request, start_params};
use crate::hub_rpc::{file_name_ok, observe, verified_sha};
use crate::rpc::{Bridge, Rpc, RpcError, arg, session, str_arg};

/// Longest single jog step.
pub(crate) const JOG_MAX_MM: f64 = 10.0;
/// Fastest jog, in mm per minute: X and Y, then Z.
const JOG_FEED_XY: f64 = 6000.0;
const JOG_FEED_Z: f64 = 600.0;
const JOG_FEED_DEFAULT_XY: f64 = 3000.0;
const JOG_FEED_DEFAULT_Z: f64 = 300.0;

/// The three lines one jog sends: relative mode, the move, absolute mode again.
pub(crate) fn jog_lines(axis: JogAxis, distance_mm: f64, feed_mm_min: Option<f64>) -> Rpc<[String; 3]> {
    let (name, cap, dflt) = match axis {
        JogAxis::X => ("X", JOG_FEED_XY, JOG_FEED_DEFAULT_XY),
        JogAxis::Y => ("Y", JOG_FEED_XY, JOG_FEED_DEFAULT_XY),
        JogAxis::Z => ("Z", JOG_FEED_Z, JOG_FEED_DEFAULT_Z),
    };
    let out = |what: String| Err(RpcError::new("out_of_range", what));
    if !distance_mm.is_finite() || distance_mm == 0.0 || distance_mm.abs() > JOG_MAX_MM {
        return out(format!("a jog is 0.1 to {JOG_MAX_MM} mm either way"));
    }
    if (distance_mm.abs() - 0.1) < -1e-9 {
        return out(format!("a jog is 0.1 to {JOG_MAX_MM} mm either way"));
    }
    let feed = feed_mm_min.unwrap_or(dflt);
    if !feed.is_finite() || feed < 60.0 || feed > cap {
        return out(format!("{name} moves at 60 to {cap} mm/min"));
    }
    Ok([
        "G91".to_owned(),
        format!("G1 {name}{distance_mm:.1} F{feed:.0}"),
        "G90".to_owned(),
    ])
}

fn is_running(s: PrinterState) -> bool {
    matches!(
        s,
        PrinterState::Printing | PrinterState::Paused | PrinterState::Preparing
    )
}

/// A path under the printer's G-code folder: folders allowed; `..`, a drive (`0:`), backslashes and
/// hidden characters not.
pub(crate) fn stored_path_ok(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 255
        && !path.starts_with('/')
        && !path.contains(':')
        && path.split('/').all(file_name_ok)
}

/// Why a jog may not move, given what the printer reports. `bed_clear` is the hub's bed record.
pub(crate) fn jog_problem(
    axis: JogAxis,
    distance_mm: f64,
    m: &Motion,
    state: PrinterState,
    bed_clear: bool,
) -> Rpc<()> {
    let (i, name) = match axis {
        JogAxis::X => (0, "X"),
        JogAxis::Y => (1, "Y"),
        JogAxis::Z => (2, "Z"),
    };
    let at = |a: Option<[f64; 3]>| a.and_then(|v| v.get(i).copied()).filter(|v| v.is_finite());
    if m.homed.is_some_and(|h| h.get(i) == Some(&false)) {
        return Err(RpcError::new(
            "not_homed",
            format!("{name} is not homed; home the printer first"),
        ));
    }
    let down = axis == JogAxis::Z && distance_mm < 0.0;
    let pos = at(m.position);
    if down && pos.is_none() {
        return Err(RpcError::new(
            "position_unknown",
            "this printer does not report where the head is, so Z only moves up (away from the bed) here",
        ));
    }
    if down && state == PrinterState::Finished && !bed_clear {
        return Err(RpcError::new(
            "bed_check",
            "the last print may still be on the plate; confirm the plate is clear before lowering the nozzle",
        ));
    }
    if let Some(p) = pos {
        let target = p + distance_mm;
        let lo = at(m.min).unwrap_or(if axis == JogAxis::Z {
            0.0
        } else {
            f64::NEG_INFINITY
        });
        let hi = at(m.max).unwrap_or(f64::INFINITY);
        if target < lo - 1e-6 || target > hi + 1e-6 {
            let range = |v: f64| {
                if v.is_finite() {
                    format!("{v:.1}")
                } else {
                    "the end".to_owned()
                }
            };
            return Err(RpcError::new(
                "out_of_range",
                format!(
                    "{name} is at {p:.1} mm and may move between {} and {} mm",
                    range(lo),
                    range(hi)
                ),
            ));
        }
    }
    Ok(())
}

fn mint_gcode(b: &Arc<Bridge>, printer: &str, line: &str, title: &str) -> Rpc<ApprovalToken> {
    let broker = b
        .broker
        .clone()
        .ok_or_else(|| RpcError::new("not_supported", "this bridge has no approval broker"))?;
    let params = json!({ "printerId": printer, "line": line });
    let t = broker
        .mint(
            internal_request(StartOrigin::LocalClick, printer, "printer.gcode", &params, title),
            false,
        )
        .map_err(|e| RpcError::new("approval_invalid", e.to_string()))?;
    Ok(ApprovalToken {
        request_id: t.request_id,
        token: t.token,
        expires_at: t.expires_at,
    })
}

/// Sends `line` under its own token, once more if the first send fails.
async fn send_twice(
    b: &Arc<Bridge>,
    s: &dyn PrinterSession,
    printer: &str,
    line: &str,
    title: &str,
) -> Rpc<()> {
    let t = mint_gcode(b, printer, line, title)?;
    if s.send_gcode(line, &t).await.is_ok() {
        return Ok(());
    }
    let t = mint_gcode(b, printer, line, title)?;
    s.send_gcode(line, &t).await.map_err(RpcError::from)
}

/// A jog whose closing `G90` did not go through left the printer in relative mode: send `G90` before
/// the next jog or start. Every start path calls this with the printer held.
pub(crate) async fn settle_absolute(b: &Arc<Bridge>, printer: &str, s: &dyn PrinterSession) -> Rpc<()> {
    if !b.hub.relative_left(printer) {
        return Ok(());
    }
    send_twice(b, s, printer, "G90", "Absolute positioning").await?;
    b.hub.set_relative_left(printer, false);
    crate::hub_rpc::save(b).await;
    Ok(())
}

/// `jog {printerId, axis, distanceMm, feedMmMin?}`.
async fn jog(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = str_arg(p, "printerId")?;
    let axis: JogAxis = arg(p, "axis")?;
    let distance: f64 = arg(p, "distanceMm")?;
    let feed: Option<f64> = p.get("feedMmMin").and_then(Value::as_f64);
    let lines = jog_lines(axis, distance, feed)?;
    let s = session(b, &printer).await?;
    // Held before the state is read, so no queued start can begin between the check and the move.
    let held = b.hub.printer_lock(&printer);
    let _g = held.lock().await;
    let st = observe(b, &printer)
        .await
        .filter(|s| s.state != PrinterState::Offline)
        .ok_or_else(|| RpcError::new("unreachable", "the printer did not answer"))?;
    if st.state != PrinterState::Idle && st.state != PrinterState::Finished {
        return Err(RpcError::new(
            "bad_state",
            "the head only moves by hand while the printer is idle",
        ));
    }
    let motion = s.motion().await.unwrap_or_default();
    let bed_clear = b.hub.bed(&printer).state == sx_permit::BedState::Clear;
    jog_problem(axis, distance, &motion, st.state, bed_clear)?;
    let title = "Move the head";
    settle_absolute(b, &printer, s.as_ref()).await?;
    let [rel, mv, abs] = lines;
    let t = mint_gcode(b, &printer, &rel, title)?;
    s.send_gcode(&rel, &t).await?;
    let moved = async {
        let t = mint_gcode(b, &printer, &mv, title)?;
        s.send_gcode(&mv, &t).await.map_err(RpcError::from)
    }
    .await;
    // Absolute mode comes back whether or not the move went through; if it cannot, the next jog or
    // start sends it first.
    if let Err(e) = send_twice(b, s.as_ref(), &printer, &abs, title).await {
        b.hub.set_relative_left(&printer, true);
        crate::hub_rpc::save(b).await;
        return Err(e);
    }
    moved?;
    Ok(json!({ "ok": true }))
}

/// `objects` of `print.local` and `start`: the plate's objects as the app sliced them, kept for
/// printers that cannot list them (Bambu Lab). Ids are the labels the G-code carries.
pub(crate) fn plate_objects_arg(p: &Value) -> Rpc<Option<Vec<PrintObject>>> {
    let Some(v) = p.get("objects").filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let bad = |why: &str| RpcError::new("bad_request", format!("objects: {why}"));
    let list: Vec<PrintObject> = serde_json::from_value(v.clone()).map_err(|_| bad("malformed"))?;
    if list.len() > MAX_OBJECTS {
        return Err(bad("at most 256 objects"));
    }
    let mut seen = std::collections::HashSet::new();
    for o in &list {
        if !sx_connect::object_id_ok(&o.id) || !seen.insert(o.id.as_str()) {
            return Err(bad("each id is a unique object label"));
        }
        let finite = |q: &[f64; 2]| q.iter().all(|x| x.is_finite());
        if o.polygon.len() > MAX_OUTLINE
            || !o.polygon.iter().all(finite)
            || !o.center.as_ref().is_none_or(finite)
        {
            return Err(bad("outlines are at most 64 finite points"));
        }
    }
    Ok(Some(tidy_objects(list)))
}

/// Keeps the objects of a plate the hub just started on `printer`.
pub(crate) async fn keep_plate_objects(
    b: &Arc<Bridge>,
    printer: &str,
    job: &str,
    objects: Option<Vec<PrintObject>>,
) {
    let Some(objects) = objects.filter(|o| !o.is_empty()) else {
        return;
    };
    let epoch = b.hub.bed(printer).epoch;
    b.hub.set_job_objects(
        printer,
        Some(JobObjects {
            job: job.to_owned(),
            epoch,
            objects,
            skipped: Vec::new(),
        }),
    );
    crate::hub_rpc::save(b).await;
}

/// A file name as the printer reports a job: `lid.gcode.3mf` and `lid` are the same job.
fn job_stem(n: &str) -> &str {
    let n = n.rsplit('/').next().unwrap_or(n);
    [".gcode.3mf", ".3mf", ".gcode", ".bgcode"]
        .iter()
        .find_map(|e| n.strip_suffix(e))
        .unwrap_or(n)
}

/// The objects the hub keeps for the job `printer` is running now, with what is skipped. `None` when
/// the hub did not start this job with its objects: another job runs, or the bed epoch moved.
async fn kept_objects(
    b: &Arc<Bridge>,
    printer: &str,
    s: &dyn PrinterSession,
    job: Option<&str>,
) -> Option<Vec<PrintObject>> {
    let rec = b.hub.job_objects(printer)?;
    if rec.epoch != b.hub.bed(printer).epoch || job.map(job_stem) != Some(job_stem(&rec.job)) {
        return None;
    }
    let reported = s.reported_skips().await;
    Some(
        rec.objects
            .into_iter()
            .map(|mut o| {
                o.skipped = rec.skipped.contains(&o.id) || reported.contains(&o.id);
                o
            })
            .collect(),
    )
}

/// The refusal for a print the hub did not start, on a printer that cannot list its objects.
const NOT_OURS: &str = "this print was not sent from SlicerX, so its objects are unknown here; skip them on the printer's screen";

/// `objects.list {printerId}`.
async fn list_objects(b: &Arc<Bridge>, printer: &str) -> Rpc<Vec<PrintObject>> {
    let s = session(b, printer).await?;
    match s.objects().await {
        Ok(v) => Ok(tidy_objects(v)),
        Err(e) if e.code() == ErrorCode::NotSupported => {
            let st = observe(b, printer).await;
            let running = st
                .as_ref()
                .is_some_and(|s| matches!(s.state, PrinterState::Printing | PrinterState::Paused));
            let job = st.as_ref().and_then(|s| s.job_name.clone());
            match kept_objects(b, printer, s.as_ref(), job.as_deref()).await {
                Some(v) if running => Ok(v),
                _ => Err(RpcError::new("not_supported", NOT_OURS)),
            }
        }
        Err(e) => Err(e.into()),
    }
}

/// `objects.skip {printerId, id, epoch}`. `epoch` is the bed epoch the app read with the list
/// (`bed.state`), so a click on a list from an earlier print never skips in the next one.
async fn skip(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = str_arg(p, "printerId")?;
    let id = str_arg(p, "id")?;
    if !sx_connect::object_id_ok(&id) {
        return Err(RpcError::new("bad_request", "id is not an object label"));
    }
    let epoch = p
        .get("epoch")
        .and_then(Value::as_u64)
        .ok_or_else(|| RpcError::new("bad_request", "epoch (from bed.state) is required"))?;
    let st = observe(b, &printer)
        .await
        .filter(|s| s.state != PrinterState::Offline)
        .ok_or_else(|| RpcError::new("unreachable", "the printer did not answer"))?;
    if !matches!(st.state, PrinterState::Printing | PrinterState::Paused) {
        return Err(RpcError::new(
            "bad_state",
            "objects can only be skipped while a print is running",
        ));
    }
    if b.hub.bed(&printer).epoch != epoch {
        return Err(RpcError::new(
            "job_changed",
            "the print changed since the list was read; look at the objects again",
        ));
    }
    let sess = session(b, &printer).await?;
    let kept = match sess.objects().await {
        Ok(known) => match known.iter().find(|o| o.id == id) {
            None => {
                return Err(RpcError::new(
                    "not_found",
                    "the printer does not list that object",
                ));
            }
            Some(o) if o.skipped => return Err(RpcError::new("bad_state", "that object is already skipped")),
            Some(_) => false,
        },
        // A printer that cannot list its objects (Bambu Lab) takes only an object of the plate this
        // hub started for the job running now.
        Err(e) if e.code() == ErrorCode::NotSupported => {
            let known = kept_objects(b, &printer, sess.as_ref(), st.job_name.as_deref())
                .await
                .ok_or_else(|| RpcError::new("not_supported", NOT_OURS))?;
            match known.iter().find(|o| o.id == id) {
                None => {
                    return Err(RpcError::new(
                        "not_found",
                        "the plate SlicerX sent has no such object",
                    ));
                }
                Some(o) if o.skipped => {
                    return Err(RpcError::new("bad_state", "that object is already skipped"));
                }
                Some(_) => true,
            }
        }
        Err(e) => return Err(e.into()),
    };
    let line = sx_connect::skip_object_line(&id);
    let t = mint_gcode(b, &printer, &line, "Skip an object")?;
    sess.skip_object(&id, &t).await?;
    if kept {
        b.hub.note_skip(&printer, &id);
        crate::hub_rpc::save(b).await;
    }
    Ok(json!({ "ok": true }))
}

/// `files.start {printerId, path, opts?, bedClear?, unverifiedOk?}`: print a file already on the
/// printer. The click is the approval, as with `print.local`.
pub(crate) async fn start_stored(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = str_arg(p, "printerId")?;
    let path = str_arg(p, "path")?;
    if !stored_path_ok(&path) {
        return Err(RpcError::new(
            "bad_request",
            "path is not a file name on the printer",
        ));
    }
    let opts: StartOptions = p
        .get("opts")
        .filter(|o| !o.is_null())
        .map(|o| serde_json::from_value(o.clone()))
        .transpose()
        .map_err(|_| RpcError::new("bad_request", "opts is malformed"))?
        .unwrap_or_default();
    let bed_clear = p.get("bedClear").and_then(Value::as_bool) == Some(true);
    let unverified_ok = p.get("unverifiedOk").and_then(Value::as_bool) == Some(true);
    crate::guard::before_start(
        b,
        &printer,
        p.get("plateOk").and_then(Value::as_bool) == Some(true),
    )
    .await?;
    let broker = b
        .broker
        .clone()
        .ok_or_else(|| RpcError::new("not_supported", "this bridge has no approval broker"))?;
    if !b.hub.begin_start(&printer) {
        return Err(RpcError::new(
            "busy",
            "another start on this printer is in progress",
        ));
    }
    let held = b.hub.printer_lock(&printer);
    let guard = held.lock().await;
    let out = start_stored_inner(b, &broker, &printer, &path, opts, bed_clear, unverified_ok).await;
    drop(guard);
    b.hub.end_start(&printer);
    crate::hub_rpc::save(b).await;
    out
}

async fn start_stored_inner(
    b: &Arc<Bridge>,
    broker: &sx_permit::ApprovalBroker,
    printer: &str,
    path: &str,
    opts: StartOptions,
    bed_clear: bool,
    unverified_ok: bool,
) -> Rpc<Value> {
    let st = observe(b, printer)
        .await
        .filter(|s| s.state != PrinterState::Offline)
        .ok_or_else(|| RpcError::new("unreachable", "the printer did not answer"))?;
    if is_running(st.state) {
        return Err(RpcError::new("bad_state", "the printer is busy with a print"));
    }
    let bed = b.hub.bed(printer);
    sx_permit::check_start(Some(StartOrigin::LocalClick), bed.state, false, bed_clear)
        .map_err(|e| RpcError::new(e.code(), e.to_string()))?;
    let sha = verified_sha(b, printer, path, true).await;
    if sha.is_none() && !unverified_ok {
        return Err(RpcError::new(
            "unverified_file",
            "this file did not go up through SlicerX, so its content cannot be checked; confirm to print it anyway",
        ));
    }
    let name = path.rsplit('/').next().unwrap_or(path).to_owned();
    let rf = RemoteFile {
        printer_id: printer.to_owned(),
        path: path.to_owned(),
        name: name.clone(),
        sha256: sha,
    };
    let title = format!("Print {name}");
    let t = broker
        .mint(
            internal_request(
                StartOrigin::LocalClick,
                printer,
                "printer.start",
                &start_params(printer, &rf, &opts),
                &title,
            ),
            bed_clear,
        )
        .map_err(|e| RpcError::new("approval_invalid", e.to_string()))?;
    let token = ApprovalToken {
        request_id: t.request_id,
        token: t.token,
        expires_at: t.expires_at,
    };
    let sess = session(b, printer).await?;
    settle_absolute(b, printer, sess.as_ref()).await?;
    sess.start(&rf, opts, &token).await?;
    if sess.reports_start_late() {
        b.hub.note_start_pending(printer);
    }
    crate::hub_rpc::started(b, printer, &name);
    Ok(json!({ "file": rf, "started": true }))
}

/// Every device-page method. Read methods take no token.
pub(crate) async fn call(b: &Arc<Bridge>, method: &str, p: &Value) -> Rpc<Value> {
    match method {
        "files.list" => {
            let s = session(b, &str_arg(p, "printerId")?).await?;
            Ok(serde_json::to_value(tidy_files(s.list_files().await?)).unwrap_or(Value::Null))
        }
        "history.list" => {
            let s = session(b, &str_arg(p, "printerId")?).await?;
            Ok(serde_json::to_value(tidy_history(s.history().await?)).unwrap_or(Value::Null))
        }
        "issues.list" => {
            let s = session(b, &str_arg(p, "printerId")?).await?;
            Ok(serde_json::to_value(s.issues().await?).unwrap_or(Value::Null))
        }
        "objects.list" => {
            let printer = str_arg(p, "printerId")?;
            Ok(serde_json::to_value(list_objects(b, &printer).await?).unwrap_or(Value::Null))
        }
        "objects.skip" => skip(b, p).await,
        "jog" => jog(b, p).await,
        "files.start" => start_stored(b, p).await,
        other => Err(RpcError::new("bad_request", format!("unknown method {other}"))),
    }
}

const MAX_FILES: usize = 1000;
const MAX_HISTORY: usize = 200;
const MAX_OBJECTS: usize = 256;
const MAX_OUTLINE: usize = 64;

/// Drops hidden characters (bidirectional overrides, zero-width marks, controls) from a name.
fn plain(name: &str) -> String {
    let hidden = |c: char| {
        c.is_control()
            || matches!(c, '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    };
    name.chars()
        .filter(|c| !hidden(*c))
        .collect::<String>()
        .trim()
        .to_owned()
}

/// The newest files whose path a start would take; others are left out.
pub(crate) fn tidy_files(mut v: Vec<StoredFile>) -> Vec<StoredFile> {
    v.retain(|f| stored_path_ok(&f.path) && file_name_ok(&f.name));
    v.truncate(MAX_FILES);
    v
}

/// Records with readable names, at most `MAX_HISTORY`.
pub(crate) fn tidy_history(mut v: Vec<PrintRecord>) -> Vec<PrintRecord> {
    v.retain(|r| !r.name.is_empty() && r.name.len() <= 255 && r.name.split('/').all(file_name_ok));
    v.truncate(MAX_HISTORY);
    v
}

/// At most `MAX_OBJECTS` objects, outlines thinned to `MAX_OUTLINE` points, names without hidden
/// characters, and copies that would read alike numbered (`bracket, copy 2`).
pub(crate) fn tidy_objects(mut v: Vec<PrintObject>) -> Vec<PrintObject> {
    v.truncate(MAX_OBJECTS);
    for o in &mut v {
        o.name = plain(&o.name);
        if o.name.is_empty() {
            o.name.clone_from(&o.id);
        }
        o.name
            .truncate(o.name.char_indices().nth(80).map_or(o.name.len(), |(i, _)| i));
        let n = o.polygon.len();
        if n > MAX_OUTLINE {
            o.polygon = (0..MAX_OUTLINE)
                .filter_map(|k| o.polygon.get(k * n / MAX_OUTLINE).copied())
                .collect();
        }
    }
    let mut count: HashMap<String, usize> = HashMap::new();
    for o in &v {
        *count.entry(o.name.clone()).or_default() += 1;
    }
    let mut nth: HashMap<String, usize> = HashMap::new();
    for o in &mut v {
        if count.get(&o.name).copied().unwrap_or(0) > 1 {
            let k = nth.entry(o.name.clone()).or_default();
            *k += 1;
            if *k > 1 {
                o.name = format!("{}, copy {k}", o.name);
            }
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_jog_is_three_plain_lines_inside_the_limits() {
        let l = jog_lines(JogAxis::X, -5.0, None).unwrap();
        assert_eq!(l, ["G91", "G1 X-5.0 F3000", "G90"]);
        assert_eq!(
            jog_lines(JogAxis::Z, 0.5, Some(300.0)).unwrap()[1],
            "G1 Z0.5 F300"
        );
        for line in &l {
            assert_eq!(sx_connect::gcode_line_problem(line), None);
        }
    }

    #[test]
    fn a_jog_outside_the_limits_is_refused_not_clamped() {
        assert_eq!(
            jog_lines(JogAxis::X, 10.1, None).unwrap_err().code,
            "out_of_range"
        );
        assert!(jog_lines(JogAxis::X, 0.0, None).is_err());
        assert!(jog_lines(JogAxis::X, 0.05, None).is_err());
        assert!(jog_lines(JogAxis::X, f64::NAN, None).is_err());
        assert!(jog_lines(JogAxis::Y, 5.0, Some(6001.0)).is_err());
        assert!(
            jog_lines(JogAxis::Z, 5.0, Some(601.0)).is_err(),
            "Z is slower than X and Y"
        );
        assert!(jog_lines(JogAxis::Z, 5.0, Some(10.0)).is_err());
    }

    #[test]
    fn stored_paths_keep_to_the_printers_folder() {
        assert!(stored_path_ok("lid.gcode"));
        assert!(stored_path_ok("parts/lid v2.gcode"));
        assert!(!stored_path_ok("../etc/passwd"));
        assert!(!stored_path_ok("/abs.gcode"));
        assert!(!stored_path_ok("a//b.gcode"));
        assert!(!stored_path_ok("a\nb.gcode"));
        assert!(!stored_path_ok("a\\b.gcode"));
        assert!(!stored_path_ok(""));
        assert!(
            !stored_path_ok("0:/sys/config.g"),
            "a drive path leaves the G-code folder"
        );
        assert!(!stored_path_ok("1:/x.gcode"));
        assert!(!stored_path_ok("sub/0:x.gcode"));
    }

    fn motion(homed: Option<[bool; 3]>, pos: Option<[f64; 3]>) -> Motion {
        Motion {
            homed,
            position: pos,
            min: pos.map(|_| [0.0, 0.0, 0.0]),
            max: pos.map(|_| [220.0, 220.0, 250.0]),
        }
    }

    #[test]
    fn a_jog_needs_homed_axes_and_stays_inside_the_axis_range() {
        let idle = PrinterState::Idle;
        let known = motion(Some([true, true, true]), Some([5.0, 100.0, 4.0]));
        assert!(jog_problem(JogAxis::X, 5.0, &known, idle, false).is_ok());
        assert_eq!(
            jog_problem(JogAxis::X, -10.0, &known, idle, false)
                .unwrap_err()
                .code,
            "out_of_range"
        );
        assert_eq!(
            jog_problem(JogAxis::Z, -5.0, &known, idle, false)
                .unwrap_err()
                .code,
            "out_of_range",
            "below the bed"
        );
        assert!(jog_problem(JogAxis::Z, -4.0, &known, idle, false).is_ok());
        let unhomed = motion(Some([true, true, false]), Some([5.0, 5.0, 4.0]));
        assert_eq!(
            jog_problem(JogAxis::Z, 1.0, &unhomed, idle, false)
                .unwrap_err()
                .code,
            "not_homed"
        );
        assert!(jog_problem(JogAxis::X, 1.0, &unhomed, idle, false).is_ok());
    }

    #[test]
    fn without_a_position_z_only_moves_up_and_a_finished_plate_needs_the_bed_answer() {
        let idle = PrinterState::Idle;
        let blind = Motion::default();
        assert_eq!(
            jog_problem(JogAxis::Z, -1.0, &blind, idle, true)
                .unwrap_err()
                .code,
            "position_unknown"
        );
        assert!(jog_problem(JogAxis::Z, 1.0, &blind, idle, false).is_ok());
        assert!(jog_problem(JogAxis::X, -10.0, &blind, idle, false).is_ok());
        let homed_only = Motion {
            homed: Some([false, true, true]),
            ..Motion::default()
        };
        assert_eq!(
            jog_problem(JogAxis::X, 1.0, &homed_only, idle, false)
                .unwrap_err()
                .code,
            "not_homed"
        );
        let known = motion(Some([true, true, true]), Some([5.0, 5.0, 20.0]));
        let done = PrinterState::Finished;
        assert_eq!(
            jog_problem(JogAxis::Z, -1.0, &known, done, false)
                .unwrap_err()
                .code,
            "bed_check"
        );
        assert!(jog_problem(JogAxis::Z, -1.0, &known, done, true).is_ok());
        assert!(jog_problem(JogAxis::Z, 1.0, &known, done, false).is_ok());
    }

    fn obj(id: &str, name: &str) -> PrintObject {
        PrintObject {
            id: id.into(),
            name: name.into(),
            skipped: false,
            center: None,
            polygon: Vec::new(),
        }
    }

    #[test]
    fn lists_are_capped_cleaned_and_copies_numbered() {
        let o = tidy_objects(vec![
            obj("1", "bracket"),
            obj("2", "bracket"),
            obj("3", "lid\u{202e}gpj"),
            obj("4", "bracket"),
        ]);
        assert_eq!(
            o.iter().map(|o| o.name.as_str()).collect::<Vec<_>>(),
            ["bracket", "bracket, copy 2", "lidgpj", "bracket, copy 3"]
        );
        let mut big = obj("5", "big");
        big.polygon = (0..1000).map(|i| [f64::from(i), 0.0]).collect();
        assert_eq!(tidy_objects(vec![big])[0].polygon.len(), MAX_OUTLINE);
        assert_eq!(
            tidy_objects((0..300).map(|i| obj(&i.to_string(), "x")).collect()).len(),
            MAX_OBJECTS
        );
        let f = |p: &str| StoredFile {
            path: p.into(),
            name: p.rsplit('/').next().unwrap().into(),
            size: None,
            modified: None,
        };
        let files = tidy_files(vec![f("ok.gcode"), f("a\u{202e}b.gcode"), f("0:/sys/config.g")]);
        assert_eq!(files.len(), 1);
        assert_eq!(
            tidy_files((0..1500).map(|i| f(&format!("{i}.gcode"))).collect()).len(),
            MAX_FILES
        );
        let r = |n: &str| PrintRecord {
            name: n.into(),
            outcome: "completed".into(),
            detail: None,
            started_at: None,
            duration_s: None,
            filament_mm: None,
        };
        assert_eq!(
            tidy_history(vec![r("sub/a.gcode"), r("b\u{200b}.gcode")]).len(),
            1
        );
    }

    #[test]
    fn plate_objects_from_the_app_are_checked() {
        let ok = json!({ "objects": [{ "id": "0", "name": "lid", "skipped": false, "polygon": [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]] }] });
        assert_eq!(plate_objects_arg(&ok).unwrap().unwrap().len(), 1);
        assert!(plate_objects_arg(&json!({})).unwrap().is_none());
        for bad in [
            json!({ "objects": [{ "id": "0 M112", "name": "x", "skipped": false }] }),
            json!({ "objects": [{ "id": "1", "name": "x", "skipped": false }, { "id": "1", "name": "y", "skipped": false }] }),
            json!({ "objects": [{ "id": "1", "name": "x", "skipped": false, "polygon": vec![[0.0, 0.0]; 65] }] }),
            json!({ "objects": "nope" }),
        ] {
            assert_eq!(plate_objects_arg(&bad).unwrap_err().code, "bad_request", "{bad}");
        }
        assert_eq!(job_stem("lid.gcode.3mf"), "lid");
        assert_eq!(job_stem("cache/lid.3mf"), "lid");
    }
}
