// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Work an agent (the MCP server) asks for that only a person may approve: start a print, resume,
//! send raw G-code, home, skip one object of the running print. The agent registers the card together with the work. The hub checks that the
//! card's actions are exactly the work's (same printer, file hash, options, line), shows the card to
//! the app and phones, and when a person approves it there, runs the work itself with the token.
//! The agent never sees the token and cannot run the work on its own.
use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Value, json};
use sx_connect::{Adjustment, ApprovalToken, JobFile, RemoteFile, StartOptions};

use crate::device::HomeLine;
use crate::hub::{lock, start_params, upload_params};
use crate::hub_rpc::decode_file;
use crate::rpc::{Bridge, Rpc, RpcError, session, str_arg};

/// Longest an agent's card stays open: long enough to walk to the printer, short enough that a
/// stream of cards cannot keep the waiting slots full.
pub(crate) const AGENT_CARD_TTL: std::time::Duration = std::time::Duration::from_mins(30);
/// Local agent work waiting for a person, at most this many at once. Remote cards do not count
/// against it, so pause and cancel from afar always have room.
const MAX_WAITING: usize = 32;
/// Cards raised over remote access (`jobs.control`) waiting at once, overall and per pairing, kept
/// apart from the local slots in both directions.
const MAX_REMOTE: usize = 8;
const REMOTE_PER_PAIRING: usize = 2;

pub(crate) enum Work {
    /// Upload a file and start it.
    Print {
        printer: String,
        file: JobFile,
        opts: StartOptions,
    },
    Resume {
        printer: String,
    },
    Gcode {
        printer: String,
        line: String,
    },
    /// Home every axis (`G28`) under the hub's home rules, checked when the person approves. Its card
    /// action is `printer.home`, never the raw line, so a person sees a home and the hub's rules.
    Home {
        printer: String,
    },
    /// A change to a running print, checked against the safe limits when it runs.
    Adjust {
        printer: String,
        change: Adjustment,
    },
    /// Pause or cancel a print, asked for over remote access (`jobs.control`).
    Pause {
        printer: String,
    },
    Cancel {
        printer: String,
    },
    /// Skip one object of the running print (`objects.skip`). It only stops extrusion for that
    /// object, so an approver phone may approve it from afar. `epoch` is the bed epoch of the print it
    /// was asked for, which must be the running print's when the card is raised and is in its hash.
    Skip {
        printer: String,
        id: String,
        epoch: u64,
    },
    /// A connected app's tool a person has to approve, such as switching a Home Assistant device.
    Plugin {
        plugin: String,
        tool: String,
        input: Value,
    },
}

/// Connected apps whose tools can ride on a card, and so be run by the hub once a person approves.
const PLUGIN_WORK: [&str; 2] = ["spoolman", "home-assistant"];

impl Work {
    /// `work: {kind: "print", printerId, file: {name, kind, sha256, dataBase64}, opts?}`,
    /// `{kind: "resume", printerId}`, `{kind: "gcode", printerId, line}` or `{kind: "home", printerId}`.
    pub(crate) fn parse(p: &Value) -> Rpc<Self> {
        // `{kind: "plugin", pluginId, tool, input}`: a connected app's tool, by its bare name.
        if p.get("kind").and_then(Value::as_str) == Some("plugin") {
            let plugin = str_arg(p, "pluginId")?;
            if !PLUGIN_WORK.contains(&plugin.as_str()) {
                return Err(RpcError::new(
                    "bad_request",
                    "work.pluginId is a connected app: spoolman or home-assistant",
                ));
            }
            let tool = str_arg(p, "tool")?;
            let bare = !tool.is_empty()
                && tool.len() <= 64
                && tool
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_');
            if !bare {
                return Err(RpcError::new(
                    "bad_request",
                    "work.tool is the tool's bare name, such as call_service",
                ));
            }
            let input = p.get("input").cloned().unwrap_or_else(|| json!({}));
            if !input.is_object() {
                return Err(RpcError::new("bad_request", "work.input is an object"));
            }
            return Ok(Work::Plugin { plugin, tool, input });
        }
        let printer = str_arg(p, "printerId")?;
        match p.get("kind").and_then(Value::as_str) {
            Some("print") => {
                let opts: StartOptions = p
                    .get("opts")
                    .filter(|o| !o.is_null())
                    .map(|o| serde_json::from_value(o.clone()))
                    .transpose()
                    .map_err(|_| RpcError::new("bad_request", "work.opts is malformed"))?
                    .unwrap_or_default();
                // Slot ids reach the printer and the card: short printable text only.
                let slot_ok = |v: &String| {
                    !v.is_empty() && v.len() <= 32 && v.bytes().all(|b| (0x21..=0x7e).contains(&b))
                };
                if opts.slot_map.as_ref().is_some_and(|m| !m.values().all(slot_ok)) {
                    return Err(RpcError::new(
                        "bad_request",
                        "work.opts.slotMap holds slot ids of 1 to 32 printable characters",
                    ));
                }
                Ok(Work::Print {
                    printer,
                    file: decode_file(p)?,
                    opts,
                })
            }
            Some("resume") => Ok(Work::Resume { printer }),
            Some("home") => Ok(Work::Home { printer }),
            Some("gcode") => {
                let line = str_arg(p, "line")?;
                // One G-code command, short enough that every card shows it whole: a line break
                // would hide a second command behind a long first one (N1).
                if let Some(why) = sx_connect::gcode_line_problem(&line) {
                    return Err(RpcError::new("bad_request", format!("work.line: {why}")));
                }
                Ok(Work::Gcode { printer, line })
            }
            Some("skip") => {
                let id = str_arg(p, "id")?;
                if !sx_connect::object_id_ok(&id) {
                    return Err(RpcError::new("bad_request", "work.id is not an object label"));
                }
                let epoch = p.get("epoch").and_then(Value::as_u64).ok_or_else(|| {
                    RpcError::new(
                        "bad_request",
                        "work.epoch is the bed epoch of the running print, from bed.state",
                    )
                })?;
                Ok(Work::Skip { printer, id, epoch })
            }
            Some("adjust") => Ok(Work::Adjust {
                printer,
                change: serde_json::from_value(p.get("change").cloned().unwrap_or(Value::Null))
                    .map_err(|_| RpcError::new("bad_request", "work.change is malformed"))?,
            }),
            _ => Err(RpcError::new(
                "bad_request",
                "work.kind is print, resume, gcode, home, adjust, skip or plugin",
            )),
        }
    }

    /// A skip names the print running now: its epoch must be the hub's own for the printer.
    pub(crate) fn check_epoch(&self, b: &Bridge) -> Rpc<()> {
        if let Work::Skip { printer, epoch, .. } = self
            && b.hub.bed(printer).epoch != *epoch
        {
            return Err(RpcError::new(
                "job_changed",
                "work.epoch is not the print running now; read bed.state again",
            ));
        }
        Ok(())
    }

    pub(crate) fn printer(&self) -> &str {
        match self {
            Work::Print { printer, .. }
            | Work::Resume { printer }
            | Work::Gcode { printer, .. }
            | Work::Home { printer }
            | Work::Adjust { printer, .. }
            | Work::Pause { printer }
            | Work::Cancel { printer }
            | Work::Skip { printer, .. } => printer,
            // a connected app's tool targets no printer
            Work::Plugin { .. } => "",
        }
    }

    /// What the hub checked about the work, for the card (`VerifiedWork` in the app): the card's
    /// own title and lines are the agent's words, these facts are the hub's.
    pub(crate) fn summary(&self) -> Value {
        match self {
            Work::Print { printer, file, opts } => json!({
                "kind": "print",
                "printerId": printer,
                "file": { "name": file.name, "sizeBytes": file.data.len(), "sha256": file.sha256 },
                "opts": opts,
            }),
            Work::Resume { printer } => json!({ "kind": "resume", "printerId": printer }),
            Work::Gcode { printer, line } => json!({ "kind": "gcode", "printerId": printer, "line": line }),
            Work::Home { printer } => json!({ "kind": "home", "printerId": printer }),
            Work::Adjust { printer, change } => {
                json!({ "kind": "adjust", "printerId": printer, "change": change })
            }
            Work::Pause { printer } => json!({ "kind": "pause", "printerId": printer }),
            Work::Cancel { printer } => json!({ "kind": "cancel", "printerId": printer }),
            Work::Skip { printer, id, epoch } => {
                json!({ "kind": "skip", "printerId": printer, "id": id, "epoch": epoch })
            }
            Work::Plugin { plugin, tool, input } => {
                json!({ "kind": "plugin", "printerId": "", "pluginId": plugin, "tool": tool, "input": input })
            }
        }
    }

    /// The card actions this work needs: `(action, target, params hash)`, in order.
    pub(crate) fn actions(&self) -> Vec<(String, String, String)> {
        let hash = |v: &Value| sx_permit::hash_params(v);
        match self {
            Work::Print { printer, file, opts } => {
                let remote = RemoteFile {
                    printer_id: printer.clone(),
                    path: String::new(),
                    name: file.name.clone(),
                    sha256: Some(file.sha256.clone()),
                };
                vec![
                    (
                        "printer.upload".into(),
                        printer.clone(),
                        hash(&upload_params(printer, &file.name, &file.sha256)),
                    ),
                    (
                        "printer.start".into(),
                        printer.clone(),
                        hash(&start_params(printer, &remote, opts)),
                    ),
                ]
            }
            Work::Resume { printer } => vec![(
                "printer.resume".into(),
                printer.clone(),
                hash(&json!({ "printerId": printer })),
            )],
            Work::Gcode { printer, line } => vec![(
                "printer.gcode".into(),
                printer.clone(),
                hash(&json!({ "printerId": printer, "line": line })),
            )],
            // Its own action: the hub checks this token, then sends G28 under its home rules with one it
            // mints, as for the app's Home button.
            Work::Home { printer } => vec![(
                "printer.home".into(),
                printer.clone(),
                hash(&json!({ "printerId": printer })),
            )],
            Work::Adjust { printer, change } => {
                let canon: Value =
                    serde_json::from_str(&sx_connect::params::adjust(printer, change)).unwrap_or(Value::Null);
                vec![("printer.adjust".into(), printer.clone(), hash(&canon))]
            }
            Work::Pause { printer } => {
                vec![(
                    "printer.pause".into(),
                    printer.clone(),
                    hash(&json!({ "printerId": printer })),
                )]
            }
            Work::Cancel { printer } => {
                vec![(
                    "printer.cancel".into(),
                    printer.clone(),
                    hash(&json!({ "printerId": printer })),
                )]
            }
            // The object and the print it belongs to: a card never skips in a later print.
            Work::Skip { printer, id, epoch } => vec![(
                "printer.skip".into(),
                printer.clone(),
                hash(&json!({ "printerId": printer, "id": id, "epoch": epoch })),
            )],
            // the same parameters the plugin checks its token against (`params::plugin`)
            Work::Plugin { plugin, tool, input } => vec![(
                "plugin.call".into(),
                plugin.clone(),
                hash(&json!({ "pluginId": plugin, "tool": tool, "input": input })),
            )],
        }
    }
}

struct Held {
    owner: u64,
    work: Work,
    /// The remote pairing that raised the card, for remote cards.
    pairing: Option<String>,
}

/// Agent work by request id, with the connection that asked.
#[derive(Default)]
pub(crate) struct Waiting(std::sync::Mutex<HashMap<String, Held>>);

impl Work {
    /// The kind name of the summary (`print`, `resume`, `gcode`, `home`, `adjust`, `pause`, `cancel`).
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Work::Print { .. } => "print",
            Work::Resume { .. } => "resume",
            Work::Gcode { .. } => "gcode",
            Work::Home { .. } => "home",
            Work::Adjust { .. } => "adjust",
            Work::Pause { .. } => "pause",
            Work::Cancel { .. } => "cancel",
            Work::Skip { .. } => "skip",
            Work::Plugin { .. } => "plugin",
        }
    }
}

impl Waiting {
    /// Checks that `req` asks for exactly `work` and keeps the work until a person answers.
    /// `open` says whether a card is still waiting at the broker: work whose card expired, was
    /// denied or was answered elsewhere is dropped first. `pairing` names the remote pairing for a
    /// card raised over remote access, which has its own smaller allowance.
    pub(crate) fn hold(
        &self,
        req: &sx_permit::ApprovalRequest,
        owner: u64,
        work: Work,
        pairing: Option<&str>,
        open: impl Fn(&str) -> bool,
    ) -> Rpc<()> {
        let want = work.actions();
        let got: Vec<(String, String, String)> = req
            .actions
            .iter()
            .map(|a| (a.action.clone(), a.target.clone(), a.params_hash.clone()))
            .collect();
        if got != want {
            return Err(RpcError::new(
                "bad_request",
                "the card's actions do not match the work (printer, file hash, options or line)",
            ));
        }
        if req.printer_id.as_deref().is_some_and(|p| p != work.printer()) {
            return Err(RpcError::new("bad_request", "the card names another printer"));
        }
        let mut w = lock(&self.0);
        w.retain(|id, _| open(id));
        if let Some(p) = pairing {
            let remote = w.values().filter(|h| h.pairing.is_some()).count();
            let mine = w.values().filter(|h| h.pairing.as_deref() == Some(p)).count();
            if mine >= REMOTE_PER_PAIRING || remote >= MAX_REMOTE {
                return Err(RpcError::new(
                    "busy",
                    "earlier requests from this device are still waiting for an answer",
                ));
            }
        }
        if pairing.is_none() && w.values().filter(|h| h.pairing.is_none()).count() >= MAX_WAITING {
            return Err(RpcError::new(
                "busy",
                "too many requests are waiting for a person",
            ));
        }
        w.insert(
            req.id.clone(),
            Held {
                owner,
                work,
                pairing: pairing.map(str::to_owned),
            },
        );
        Ok(())
    }

    /// The checked facts of the work held for a card, if any.
    pub(crate) fn summary(&self, request_id: &str) -> Option<Value> {
        lock(&self.0).get(request_id).map(|h| h.work.summary())
    }

    /// The printer and the content hash of the file a held print would start, for the remote start
    /// rule. `None` for a card holding no print.
    pub(crate) fn print_file(&self, request_id: &str) -> Option<(String, String)> {
        match &lock(&self.0).get(request_id)?.work {
            Work::Print { printer, file, .. } => Some((printer.clone(), file.sha256.clone())),
            _ => None,
        }
    }

    /// The bytes of the file a held print would start, to read what it heats.
    pub(crate) fn print_data(&self, request_id: &str) -> Option<Vec<u8>> {
        match &lock(&self.0).get(request_id)?.work {
            Work::Print { file, .. } => Some(file.data.clone()),
            _ => None,
        }
    }

    /// The kind of work held for a card, if any.
    pub(crate) fn kind(&self, request_id: &str) -> Option<&'static str> {
        lock(&self.0).get(request_id).map(|h| h.work.kind())
    }

    #[cfg(test)]
    pub(crate) fn holds(&self, request_id: &str) -> bool {
        lock(&self.0).contains_key(request_id)
    }

    pub(crate) fn take(&self, request_id: &str) -> Option<(u64, Work)> {
        lock(&self.0).remove(request_id).map(|h| (h.owner, h.work))
    }
}

/// Runs approved agent work with the person's token, then tells the agent and the app how it went
/// (`approval.done {requestId, ok, code?, message?}`).
/// `remote` says a phone approved the card from afar, so a print gets the remote start check before
/// its start command.
pub(crate) fn run(
    b: &Arc<Bridge>,
    request_id: String,
    work: Work,
    token: ApprovalToken,
    owner: u64,
    remote: bool,
) {
    let b = b.clone();
    tokio::spawn(async move {
        let printer = work.printer().to_owned();
        let out = execute(&b, &request_id, work, &token, remote).await;
        let mut data = serde_json::Map::new();
        data.insert("requestId".into(), json!(request_id));
        data.insert("printerId".into(), json!(printer));
        data.insert("ok".into(), json!(out.is_ok()));
        if let Err(e) = out {
            data.insert("code".into(), json!(e.code));
            data.insert("message".into(), json!(e.message));
        }
        // One copy for the app, one addressed to the agent that asked.
        let data = Value::Object(data);
        b.hub.emit("approval.done", data.clone());
        b.hub.emit_to("approval.done", data, owner);
    });
}

async fn execute(
    b: &Arc<Bridge>,
    request_id: &str,
    work: Work,
    token: &ApprovalToken,
    remote: bool,
) -> Rpc<()> {
    match work {
        Work::Print { printer, file, opts } => {
            // One hold for the upload and the start, so nothing else lands in between.
            let held = b.hub.printer_lock(&printer);
            let _held = held.lock().await;
            let size = u64::try_from(file.data.len()).unwrap_or(u64::MAX);
            let rf = session(b, &printer).await?.upload(file, token).await?;
            crate::hub_rpc::record_upload(b, &rf, size).await;
            // A start approved from afar: a fresh compared plate check now, after the upload, within
            // its time of the approval.
            crate::remote_start::before_start(b, request_id, &printer, Some(remote))
                .await
                .map_err(|why| RpcError::new("plate_check", why.message()))?;
            crate::hub_rpc::start_with_token_held(b, &json!({ "file": rf, "opts": opts, "token": token }))
                .await?;
            Ok(())
        }
        Work::Resume { printer } => Ok(session(b, &printer).await?.resume(token).await?),
        // A raw home line lowers the nozzle as a home does, so it goes under the home rules too.
        Work::Gcode { printer, line } if sx_connect::homes_axes(&line) => {
            crate::device::home_checked(b, &printer, None, HomeLine::Approved { line: &line, token }).await
        }
        Work::Gcode { printer, line } => Ok(session(b, &printer).await?.send_gcode(&line, token).await?),
        // A card can wait: the printer may have started a job, or finished one, since it was made. The
        // person's token is for `printer.home`; checked and used up here, it lets the hub send G28 under
        // its own token. "The plate is clear" on the card answers the plate question for this home, about
        // the plate as it is now (the hub runs the work as the person approves).
        Work::Home { printer } => {
            let broker = b
                .broker
                .as_ref()
                .ok_or_else(|| RpcError::new("not_supported", "this bridge has no approval broker"))?;
            let plate_said = broker
                .grant_info(&token.request_id)
                .is_some_and(|g| g.bed_confirmed);
            broker
                .verify(
                    &crate::hub_rpc::to_permit(token),
                    "printer.home",
                    &printer,
                    &sx_permit::hash_params(&json!({ "printerId": printer })),
                )
                .map_err(|e| RpcError::new("approval_invalid", e.to_string()))?;
            let answer = plate_said.then(|| b.hub.bed(&printer).epoch);
            crate::device::home_checked(b, &printer, answer, HomeLine::Mint).await
        }
        Work::Adjust { printer, change } => crate::adjust::apply(b, &printer, &change, token).await,
        Work::Pause { printer } => Ok(session(b, &printer).await?.pause(token).await?),
        Work::Cancel { printer } => Ok(session(b, &printer).await?.cancel(token).await?),
        // The card's token approved this skip; the hub mints the line's own, as for the app's click.
        Work::Skip { printer, id, epoch } => crate::device::skip_object(b, &printer, &id, epoch).await,
        Work::Plugin { plugin, tool, input } => {
            crate::rpc::service_call(b, &plugin, &tool, input, Some(token))
                .await
                .map(|_| ())
        }
    }
}

/// `approvals.register` from an agent: the work rides along as `work`.
pub(crate) fn work_arg(p: &Value) -> Rpc<Option<Work>> {
    match p.get("work") {
        None | Some(Value::Null) => Ok(None),
        Some(w) => Work::parse(w).map(Some),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: &str, work: &Work) -> sx_permit::ApprovalRequest {
        sx_permit::ApprovalRequest {
            id: id.to_owned(),
            session_id: "s".into(),
            tool: "printer.cancel".into(),
            permission: sx_permit::PermissionClass::Start,
            title: String::new(),
            lines: vec![],
            printer_id: Some(work.printer().to_owned()),
            params_hash: sx_permit::hash_params(&json!({})),
            actions: work
                .actions()
                .into_iter()
                .map(|(action, target, params_hash)| sx_permit::ApprovalAction {
                    action,
                    target,
                    params_hash,
                })
                .collect(),
            expires_at: "2099-01-01T00:00:00.000Z".into(),
            origin: None,
        }
    }

    fn cancel() -> Work {
        Work::Cancel {
            printer: "bay-1".into(),
        }
    }

    #[test]
    fn a_home_card_is_its_own_action_and_never_reads_as_a_raw_line() {
        let w = Work::parse(&json!({ "kind": "home", "printerId": "bay-1" })).unwrap();
        assert_eq!(w.kind(), "home");
        assert_eq!(w.summary(), json!({ "kind": "home", "printerId": "bay-1" }));
        assert_eq!(
            w.actions(),
            vec![(
                "printer.home".to_owned(),
                "bay-1".to_owned(),
                sx_permit::hash_params(&json!({ "printerId": "bay-1" }))
            )]
        );
        let g = Work::parse(&json!({ "kind": "gcode", "printerId": "bay-1", "line": "G28" })).unwrap();
        assert_ne!(w.actions(), g.actions());
        assert_ne!(w.summary(), g.summary());
    }

    #[test]
    fn m6_held_work_leaves_with_its_card_and_remote_cards_have_their_own_allowance() {
        let w = Waiting::default();
        let open = std::sync::Mutex::new(std::collections::HashSet::<String>::new());
        let is_open = |id: &str| lock(&open).contains(id);
        // Two remote cards per pairing; the third waits for an answer.
        for id in ["r1", "r2"] {
            w.hold(&card(id, &cancel()), 0, cancel(), Some("pair-a"), is_open)
                .unwrap();
            lock(&open).insert(id.to_owned());
        }
        let third = w.hold(&card("r3", &cancel()), 0, cancel(), Some("pair-a"), is_open);
        assert_eq!(third.map_err(|e| e.code), Err("busy".to_owned()));
        // Remote cards overall stop at eight, and local agents still have room after that.
        for (i, p) in ["b", "b", "c", "c", "d", "d"].iter().enumerate() {
            let id = format!("o{i}");
            w.hold(&card(&id, &cancel()), 0, cancel(), Some(p), is_open)
                .unwrap();
            lock(&open).insert(id);
        }
        let ninth = w.hold(&card("o9", &cancel()), 0, cancel(), Some("e"), is_open);
        assert_eq!(ninth.map_err(|e| e.code), Err("busy".to_owned()));
        w.hold(&card("local", &cancel()), 7, cancel(), None, is_open)
            .unwrap();
        lock(&open).insert("local".to_owned());
        // A card that expired or was denied at the broker frees its slot at the next hold.
        lock(&open).remove("r1");
        w.hold(&card("r4", &cancel()), 0, cancel(), Some("pair-a"), is_open)
            .unwrap();
        assert!(!w.holds("r1"));
        assert!(w.holds("local"));
    }

    #[test]
    fn a_connected_app_tool_rides_a_card_hashed_as_the_plugin_checks_it() {
        let input = json!({ "domain": "switch", "service": "turn_off", "entityId": "switch.bay_1_power" });
        let w = Work::parse(&json!({ "kind": "plugin", "pluginId": "home-assistant", "tool": "call_service", "input": input }))
            .unwrap();
        assert_eq!(w.kind(), "plugin");
        assert_eq!(w.printer(), "");
        let want = sx_permit::hash_params(
            &serde_json::from_str::<Value>(&sx_connect::params::plugin(
                "home-assistant",
                "call_service",
                &input,
            ))
            .unwrap(),
        );
        assert_eq!(
            w.actions(),
            vec![("plugin.call".to_owned(), "home-assistant".to_owned(), want)]
        );
        assert_eq!(w.summary()["entityId"], Value::Null);
        assert_eq!(w.summary()["input"]["entityId"], "switch.bay_1_power");
        // A card raised for one input holds no other: the work cannot change after the card is made.
        let other = Work::parse(
            &json!({ "kind": "plugin", "pluginId": "home-assistant", "tool": "call_service",
            "input": { "domain": "switch", "service": "turn_off", "entityId": "switch.bay_2_power" } }),
        )
        .unwrap();
        let waiting = Waiting::default();
        let refused = waiting.hold(&card("p1", &w), 0, other, None, |_| true);
        assert_eq!(refused.map_err(|e| e.code), Err("bad_request".to_owned()));
        assert!(!waiting.holds("p1"));
        waiting.hold(&card("p2", &w), 0, w, None, |_| true).unwrap();
        assert!(waiting.holds("p2"));
        // Taking the work hands it out once: an approval replayed for the same card finds nothing to run.
        assert!(waiting.take("p2").is_some());
        assert!(waiting.take("p2").is_none());
        // Only the connected apps the hub runs, a bare tool name and an object input.
        for bad in [
            json!({ "kind": "plugin", "pluginId": "duet", "tool": "x", "input": {} }),
            json!({ "kind": "plugin", "pluginId": "home-assistant", "tool": "home-assistant.call_service", "input": {} }),
            json!({ "kind": "plugin", "pluginId": "home-assistant", "tool": "call_service", "input": [] }),
        ] {
            assert_eq!(
                Work::parse(&bad).err().map(|e| e.code),
                Some("bad_request".to_owned()),
                "{bad}"
            );
        }
    }

    fn gcode(line: &str) -> Rpc<Work> {
        Work::parse(&json!({ "kind": "gcode", "printerId": "bay-1", "line": line }))
    }

    #[test]
    fn n1_a_second_command_cannot_hide_behind_a_long_first_line() {
        // The attack: a display message long enough to push the heater command off the card.
        let hidden = format!("M117 Checking the nozzle {}\nM104 S290", "x".repeat(120));
        for line in [
            hidden.as_str(),
            "M117 hi\nM104 S290",
            "M117 hi\rM104 S290",
            "M117 hi\u{2028}M104 S290",
            "M117 \u{202e}092S 401M",
            "M117 tab\there",
            "M117 nul\u{0}",
            "",
            "   ",
        ] {
            let e = gcode(line).err().map(|e| e.code);
            assert_eq!(e.as_deref(), Some("bad_request"), "{line:?} must be refused");
        }
        // Longer than a card shows whole, even on one line.
        assert!(gcode(&format!("M117 {}", "x".repeat(92))).is_err());
        assert!(gcode(&format!("M117 {}", "x".repeat(91))).is_ok());
        assert!(matches!(gcode("M104 S210"), Ok(Work::Gcode { line, .. }) if line == "M104 S210"));
        // Through `approvals.register` the refusal comes before any card is held or shown.
        let w = work_arg(
            &json!({ "work": { "kind": "gcode", "printerId": "bay-1", "line": "M117 a\nM104 S290" } }),
        );
        assert!(w.is_err());
    }

    #[test]
    fn n1_file_names_and_slot_ids_are_plain_text() {
        let print = |name: &str, opts: Value| {
            let data = b"G28\n";
            Work::parse(
                &json!({ "kind": "print", "printerId": "bay-1", "opts": opts, "file": {
                "name": name, "kind": "gcode", "sha256": crate::hub::sha256_hex(data),
                "dataBase64": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, data),
            } }),
            )
        };
        assert!(print("cube.gcode", Value::Null).is_ok());
        for bad in [
            "../cube.gcode",
            "a/b.gcode",
            "a\\b.gcode",
            "cube.gcode\nSHA-256: 00",
            "..",
            "cube\u{202e}edoc.gcode",
        ] {
            assert!(print(bad, Value::Null).is_err(), "{bad:?} must be refused");
        }
        assert!(print("cube.gcode", json!({ "slotMap": { "1": "A1" } })).is_ok());
        assert!(print("cube.gcode", json!({ "slotMap": { "1": "A1\nM104 S290" } })).is_err());
    }

    #[test]
    fn a_skip_card_hashes_the_object_and_its_print() {
        let w = Work::parse(&json!({ "kind": "skip", "printerId": "bay-1", "id": "part_3", "epoch": 7 }))
            .unwrap();
        assert_eq!(w.kind(), "skip");
        assert_eq!(
            w.actions(),
            vec![(
                "printer.skip".to_owned(),
                "bay-1".to_owned(),
                sx_permit::hash_params(&json!({ "printerId": "bay-1", "id": "part_3", "epoch": 7 }))
            )]
        );
        assert_eq!(w.summary()["epoch"], 7);
        assert!(Work::parse(&json!({ "kind": "skip", "printerId": "bay-1", "id": "part_3" })).is_err());
        assert!(Work::parse(&json!({ "kind": "skip", "printerId": "bay-1", "id": "a\nM104 S300" })).is_err());
        assert!(
            Work::parse(&json!({ "kind": "skip", "printerId": "bay-1", "id": "x", "epoch": "now" })).is_err()
        );
    }

    #[test]
    fn n2_local_agent_cards_never_take_the_remote_slots() {
        let w = Waiting::default();
        let open = |_: &str| true;
        for i in 0..MAX_WAITING {
            w.hold(&card(&format!("l{i}"), &cancel()), 7, cancel(), None, open)
                .unwrap();
        }
        let more = w.hold(&card("l-extra", &cancel()), 7, cancel(), None, open);
        assert_eq!(more.map_err(|e| e.code), Err("busy".to_owned()));
        // The local list is full, and a remote pause or cancel still fits.
        w.hold(&card("r1", &cancel()), 0, cancel(), Some("pair-a"), open)
            .unwrap();
    }
}
