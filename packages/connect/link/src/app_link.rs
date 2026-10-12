// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The app link: an agent uses the project open in the app. The agent sends `app.call` with a
//! method from the pinned list (roles.rs `APP_LINK_METHODS`); the hub checks that the person turned
//! the link on, that the client is remembered and allowed, and that a read only client calls only
//! read methods, then hands the call to the app's connection (`appLink.call`) and returns its
//! answer (`appLink.reply`).
//!
//! The first call from a client the person has not answered for asks the app (`appLink.ask`): allow,
//! allow read only, or deny. The answer is kept on the remembered client, so revoking the client or
//! its grant ends it. A deny holds until the hub restarts or the person allows the client in the app.
//!
//! The app's side (`appLink.*`) is app role only (roles.rs). Only the connection that registered as
//! the link's host gets calls and questions, and only it may answer them.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::hub::{iso, lock, now_ms};
use crate::roles::{LinkClass, Role, link_class};
use crate::rpc::{Bridge, Rpc, RpcError, str_arg};

/// What the person allowed a client to do with the open project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Rights {
    Read,
    Edit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Grant {
    pub rights: Rights,
    pub granted_at_ms: u64,
}

/// How long the person has to answer the question in the app.
const ASK_TIMEOUT: Duration = Duration::from_secs(120);
/// After a question nobody answered, the same client waits this long before it can ask again.
const ASK_COOLDOWN: Duration = Duration::from_secs(300);
/// How long a call waits for the app, unless it asks for longer (`timeoutMs`, at most `MAX_CALL`).
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CALL: Duration = Duration::from_secs(120);
/// The largest `args` a call may carry, as JSON. Every app link method takes small arguments.
pub(crate) const MAX_ARGS: usize = 64 * 1024;

/// The error codes the app may answer with; anything else reads as `app_error`.
const APP_CODES: &[&str] = &["invalid_input", "not_found", "not_ready", "refused", "busy"];

type Pending<T> = StdMutex<HashMap<u64, (u64, T)>>;

/// The link's live state: which app connection hosts it, and the calls and questions in flight.
#[derive(Default)]
pub(crate) struct Link {
    host: StdMutex<Option<u64>>,
    next: AtomicU64,
    /// Call id to (host connection, where its answer goes).
    calls: Pending<oneshot::Sender<Rpc<Value>>>,
    /// Question id to (host connection, (client id, where the answer goes)). One at a time.
    asks: Pending<(String, oneshot::Sender<Option<Rights>>)>,
    /// Clients the person denied since the hub started.
    denied: StdMutex<HashSet<String>>,
    /// Clients whose last question went unanswered, and when.
    unanswered: StdMutex<HashMap<String, Instant>>,
}

impl Link {
    /// A connection closed. When it hosted the link, the link has no host and its calls and
    /// questions end now (their waiters see the app close).
    pub(crate) fn closed(&self, conn: u64) {
        let mut host = lock(&self.host);
        if *host == Some(conn) {
            *host = None;
        }
        drop(host);
        lock(&self.calls).retain(|_, (h, _)| *h != conn);
        lock(&self.asks).retain(|_, (h, _)| *h != conn);
    }

    /// The person turned the link off: every question and call in flight ends now.
    pub(crate) fn turned_off(&self) {
        lock(&self.calls).clear();
        lock(&self.asks).clear();
    }

    /// A client was revoked: its deny, cooldown and open question go with it.
    pub(crate) fn forget(&self, client: &str) {
        lock(&self.denied).remove(client);
        lock(&self.unanswered).remove(client);
        lock(&self.asks).retain(|_, (_, (c, _))| c != client);
    }

    fn id(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed) + 1
    }
}

fn off() -> RpcError {
    RpcError::new(
        "app_link_off",
        format!(
            "the app link is off; the person turns on Let agents use the open project in {} Settings, Agents",
            crate::app_name()
        ),
    )
}

fn is_on(b: &Bridge) -> bool {
    lock(&b.hub.settings).app_link
}

/// An agent's `app.call {method, args, timeoutMs?}`.
pub(crate) async fn agent_call(
    b: &Bridge,
    role: Role,
    client: Option<&str>,
    partner: bool,
    p: &Value,
) -> Rpc<Value> {
    if role != Role::Agent || partner {
        return Err(RpcError::new(
            "forbidden",
            "app.call is for agents the person connected",
        ));
    }
    if !is_on(b) {
        return Err(off());
    }
    let Some(client) = client else {
        return Err(RpcError::new(
            "unauthorized",
            "the app link takes only a remembered client; connect through Connect your AI agent",
        ));
    };
    let method = str_arg(p, "method")?;
    let Some(class) = link_class(&method) else {
        return Err(RpcError::new(
            "forbidden",
            format!("the app link has no method {method}"),
        ));
    };
    let args = match p.get("args") {
        None | Some(Value::Null) => json!({}),
        Some(v @ Value::Object(_)) => v.clone(),
        Some(_) => return Err(RpcError::new("bad_request", "args is an object")),
    };
    if args.to_string().len() > MAX_ARGS {
        return Err(RpcError::new("bad_request", "args are over 64 KB"));
    }
    let host = (*lock(&b.app_link.host))
        .ok_or_else(|| RpcError::new("app_closed", format!("{} is not open", crate::app_name())))?;
    // The record decides, not the role this connection asked for: only an agent key the person
    // made or paired as an agent, never a partner app's or an app key narrowed to agent, which
    // Settings, Agents would not list and so could not revoke.
    let (name, created, grant) = {
        let clients = lock(&b.hub.clients);
        let r = clients
            .iter()
            .find(|r| r.id == client)
            .ok_or_else(|| RpcError::new("unauthorized", "this client was revoked"))?;
        if r.role != Role::Agent || r.partner {
            return Err(RpcError::new(
                "forbidden",
                "app.call is for agents the person connected",
            ));
        }
        (
            r.name.clone(),
            r.created_at_ms,
            r.app_link.as_ref().map(|g| g.rights),
        )
    };
    let rights = match grant {
        Some(r) => r,
        None => ask(b, host, client, &name, created).await?,
    };
    if !permitted(rights, class) {
        return Err(RpcError::new(
            "read_only",
            format!("the person allowed {name} to read the open project, not to change it"),
        ));
    }
    // The person may have turned the link off while the question was up.
    if !is_on(b) {
        return Err(off());
    }
    let wait = p
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .map_or(CALL_TIMEOUT, |ms| {
            Duration::from_millis(ms).clamp(Duration::from_secs(1), MAX_CALL)
        });
    relay(b, host, client, &name, &method, args, wait).await
}

/// Asks the person about a client. One question at a time on the whole hub, and a client whose
/// question went unanswered waits `ASK_COOLDOWN` before asking again.
async fn ask(b: &Bridge, host: u64, client: &str, name: &str, created_ms: u64) -> Rpc<Rights> {
    let link = &b.app_link;
    if lock(&link.denied).contains(client) {
        return Err(RpcError::new(
            "denied",
            format!("the person did not allow {name} to use the open project"),
        ));
    }
    if lock(&link.unanswered)
        .get(client)
        .is_some_and(|t| t.elapsed() < ASK_COOLDOWN)
    {
        return Err(RpcError::new(
            "not_answered",
            "the person did not answer the last question; try again in a few minutes",
        ));
    }
    let id = link.id();
    let (tx, rx) = oneshot::channel();
    {
        let mut asks = lock(&link.asks);
        if !asks.is_empty() {
            return Err(RpcError::new(
                "pending",
                format!(
                    "{} is asking the person about an agent; try again after they answer",
                    crate::app_name()
                ),
            ));
        }
        asks.insert(id, (host, (client.to_owned(), tx)));
    }
    b.hub.emit_to(
        "appLink.ask",
        json!({ "askId": id, "clientId": client, "name": name, "createdAt": iso(created_ms) }),
        host,
    );
    let answer = tokio::time::timeout(ASK_TIMEOUT, rx).await;
    lock(&link.asks).remove(&id);
    // The app takes the question down however it ended.
    b.hub.emit_to("appLink.askEnded", json!({ "askId": id }), host);
    match answer {
        Ok(Ok(Some(rights))) => {
            if !is_on(b) {
                return Err(off());
            }
            {
                let mut clients = lock(&b.hub.clients);
                let Some(r) = clients.iter_mut().find(|r| r.id == client) else {
                    return Err(RpcError::new("unauthorized", "this client was revoked"));
                };
                r.app_link = Some(Grant {
                    rights,
                    granted_at_ms: now_ms(),
                });
            }
            b.hub.audit(json!({ "origin": "local_click", "action": "appLink.allow", "clientId": client, "rights": rights }));
            crate::hub_rpc::save(b).await;
            Ok(rights)
        }
        Ok(Ok(None)) => {
            lock(&link.denied).insert(client.to_owned());
            b.hub
                .audit(json!({ "origin": "local_click", "action": "appLink.deny", "clientId": client }));
            Err(RpcError::new(
                "denied",
                format!("the person did not allow {name} to use the open project"),
            ))
        }
        // The question was dropped: the app closed, the link was turned off or the client revoked.
        Ok(Err(_)) if !is_on(b) => Err(off()),
        Ok(Err(_)) => Err(RpcError::new(
            "app_closed",
            format!("{} closed before the person answered", crate::app_name()),
        )),
        Err(_) => {
            lock(&link.unanswered).insert(client.to_owned(), Instant::now());
            Err(RpcError::new(
                "not_answered",
                "the person did not answer in time; try again in a few minutes",
            ))
        }
    }
}

async fn relay(
    b: &Bridge,
    host: u64,
    client: &str,
    name: &str,
    method: &str,
    args: Value,
    wait: Duration,
) -> Rpc<Value> {
    let link = &b.app_link;
    let id = link.id();
    let (tx, rx) = oneshot::channel();
    lock(&link.calls).insert(id, (host, tx));
    b.hub.emit_to(
        "appLink.call",
        json!({ "callId": id, "method": method, "args": args, "client": { "id": client, "name": name } }),
        host,
    );
    let out = tokio::time::timeout(wait, rx).await;
    lock(&link.calls).remove(&id);
    match out {
        Ok(Ok(r)) => r,
        Ok(Err(_)) if !is_on(b) => Err(off()),
        Ok(Err(_)) => Err(RpcError::new(
            "app_closed",
            format!("{} closed during the call", crate::app_name()),
        )),
        Err(_) => Err(RpcError::new(
            "timeout",
            format!("{} did not answer {method} in time", crate::app_name()),
        )),
    }
}

/// Whether a connection that came from `origin` may host the link: the desktop app's own window
/// (the Tauri webview) or a local development page, never the browser build on the web or a
/// program that sent no origin.
pub(crate) fn may_host(origin: Option<&str>) -> bool {
    let Some(o) = origin else { return false };
    matches!(
        o,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) || ["http://localhost", "http://127.0.0.1"].iter().any(|base| {
        o.strip_prefix(base).is_some_and(|rest| {
            rest.is_empty()
                || rest
                    .strip_prefix(':')
                    .is_some_and(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
        })
    })
}

/// The app's side: `appLink.host`, `appLink.reply`, `appLink.answer`, `appLink.grants` and
/// `appLink.revoke`. App role only (roles.rs).
pub(crate) async fn app_call(
    b: &Bridge,
    conn: u64,
    origin: Option<&str>,
    method: &str,
    p: &Value,
) -> Rpc<Value> {
    let link = &b.app_link;
    match method {
        // The desktop app's window registers its connection; a later registration takes over.
        "appLink.host" => {
            if !may_host(origin) {
                return Err(RpcError::new(
                    "forbidden",
                    format!("only the {} desktop app hosts the app link", crate::app_name()),
                ));
            }
            *lock(&link.host) = Some(conn);
            Ok(json!({ "on": lock(&b.hub.settings).app_link }))
        }
        "appLink.reply" => {
            let id = id_arg(p, "callId")?;
            let Some((_, tx)) = take_from(&link.calls, id, conn) else {
                return Err(RpcError::new(
                    "not_found",
                    format!("no call {id} waits for this connection"),
                ));
            };
            let out = if p.get("ok").and_then(Value::as_bool) == Some(true) {
                Ok(p.get("value").cloned().unwrap_or(Value::Null))
            } else {
                let code = p.get("code").and_then(Value::as_str).unwrap_or("");
                let code = APP_CODES
                    .iter()
                    .find(|c| **c == code)
                    .copied()
                    .unwrap_or("app_error");
                let message = p
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("the app could not do that");
                Err(RpcError::new(code, message.chars().take(500).collect::<String>()))
            };
            let _ = tx.send(out);
            Ok(json!({ "delivered": true }))
        }
        "appLink.answer" => {
            let id = id_arg(p, "askId")?;
            let rights = match str_arg(p, "decision")?.as_str() {
                "allow" => Some(Rights::Edit),
                "read" => Some(Rights::Read),
                "deny" => None,
                _ => return Err(RpcError::new("bad_request", "decision is allow, read or deny")),
            };
            let Some((_, (_, tx))) = take_from(&link.asks, id, conn) else {
                return Err(RpcError::new(
                    "not_found",
                    format!("no question {id} waits for this connection"),
                ));
            };
            let _ = tx.send(rights);
            Ok(json!({ "answered": true }))
        }
        "appLink.grants" => Ok(Value::Array(
            lock(&b.hub.clients)
                .iter()
                .filter(|c| c.role == Role::Agent && !c.partner)
                .map(|c| {
                    json!({
                        "clientId": c.id,
                        "name": c.name,
                        "rights": c.app_link.as_ref().map(|g| g.rights),
                        "grantedAt": c.app_link.as_ref().map(|g| iso(g.granted_at_ms)),
                        "denied": lock(&link.denied).contains(&c.id),
                    })
                })
                .collect(),
        )),
        // Takes back what the person allowed (or a deny), so the client is asked again next time.
        "appLink.revoke" => {
            let id = str_arg(p, "clientId")?;
            let found = {
                let mut clients = lock(&b.hub.clients);
                clients
                    .iter_mut()
                    .find(|r| r.id == id)
                    .map(|r| r.app_link = None)
                    .is_some()
            };
            let undenied = lock(&link.denied).remove(&id);
            lock(&link.unanswered).remove(&id);
            if !found && !undenied {
                return Err(RpcError::new("not_found", format!("no client {id}")));
            }
            b.hub
                .audit(json!({ "origin": "local_click", "action": "appLink.revoke", "clientId": id }));
            crate::hub_rpc::save(b).await;
            Ok(json!({ "revoked": true }))
        }
        other => Err(RpcError::new("bad_request", format!("unknown method {other}"))),
    }
}

/// A read only grant reads; only a full grant edits.
fn permitted(rights: Rights, class: LinkClass) -> bool {
    match class {
        LinkClass::Read => true,
        LinkClass::Edit => rights == Rights::Edit,
    }
}

fn id_arg(p: &Value, key: &str) -> Rpc<u64> {
    p.get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| RpcError::new("bad_request", format!("{key} is required")))
}

/// Takes an entry only when `conn` is the connection it went to.
fn take_from<T>(m: &Pending<T>, id: u64, conn: u64) -> Option<(u64, T)> {
    let mut m = lock(m);
    if m.get(&id).is_some_and(|(h, _)| *h == conn) {
        m.remove(&id)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_link_is_off_in_a_new_hub_and_in_a_hub_file_from_before_it() {
        assert!(!crate::hub::HubSettings::default().app_link);
        let old: crate::hub::HubSettings =
            serde_json::from_str(r#"{"experimentalConnectors":true}"#).unwrap();
        assert!(!old.app_link);
    }

    #[test]
    fn only_the_desktop_window_or_a_local_dev_page_hosts_the_link() {
        for o in [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "http://localhost:1420",
            "http://127.0.0.1",
        ] {
            assert!(may_host(Some(o)), "{o}");
        }
        for o in [
            "https://slicerx.app",
            "https://evil.example",
            "http://localhost.evil.example",
            "http://localhost:",
            "http://127.0.0.1:80/x",
            "null",
            "",
        ] {
            assert!(!may_host(Some(o)), "{o}");
        }
        assert!(!may_host(None));
    }

    #[test]
    fn turning_off_and_forgetting_end_what_is_in_flight() {
        let link = Link::default();
        let (tx, mut rx) = oneshot::channel();
        lock(&link.asks).insert(1, (3, ("c1".to_owned(), tx)));
        lock(&link.denied).insert("c2".to_owned());
        lock(&link.unanswered).insert("c1".to_owned(), Instant::now());
        link.forget("c1");
        assert!(rx.try_recv().is_err());
        assert!(lock(&link.unanswered).is_empty());
        link.forget("c2");
        assert!(lock(&link.denied).is_empty());
        let (tx, mut rx) = oneshot::channel();
        lock(&link.calls).insert(2, (3, tx));
        link.turned_off();
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn a_read_only_grant_never_edits() {
        assert!(permitted(Rights::Read, LinkClass::Read));
        assert!(!permitted(Rights::Read, LinkClass::Edit));
        assert!(permitted(Rights::Edit, LinkClass::Read));
        assert!(permitted(Rights::Edit, LinkClass::Edit));
    }

    #[test]
    fn grants_keep_their_rights_in_the_hub_file() {
        let g = Grant {
            rights: Rights::Read,
            granted_at_ms: 5,
        };
        let v = serde_json::to_value(&g).unwrap();
        assert_eq!(v, json!({ "rights": "read", "grantedAtMs": 5 }));
        let back: Grant = serde_json::from_value(v).unwrap();
        assert_eq!(back.rights, Rights::Read);
    }

    #[test]
    fn only_the_connection_a_call_went_to_takes_its_answer() {
        let m: Pending<u8> = StdMutex::default();
        lock(&m).insert(1, (7, 0));
        assert!(take_from(&m, 1, 8).is_none());
        assert!(take_from(&m, 1, 7).is_some());
        assert!(take_from(&m, 1, 7).is_none());
    }

    #[test]
    fn a_closing_host_ends_its_calls_and_leaves_others() {
        let link = Link::default();
        *lock(&link.host) = Some(3);
        let (tx, mut rx) = oneshot::channel();
        lock(&link.calls).insert(1, (3, tx));
        let (tx2, _rx2) = oneshot::channel();
        lock(&link.calls).insert(2, (4, tx2));
        link.closed(3);
        assert!(lock(&link.host).is_none());
        assert!(rx.try_recv().is_err());
        assert_eq!(lock(&link.calls).len(), 1);
    }
}
