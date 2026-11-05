// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Partner routes (`relay.partnerRoute.*`): a partner app's desktop, connected to this hub with its
//! partner key, opens a sealed byte stream to the same partner's own paired phone over the hosted
//! relay. The hub opens a pair of `pr:` relay routes for it (sx-relay's partner routes, with their
//! caps), seals each chunk in the phone's pairing session, and hands the bytes on without reading
//! them. A route carries bytes only: nothing that crosses it reaches a hub method, a printer or a
//! card. The person who owns the hub sees every route in Settings, Devices and can close it.
//!
//! Chunks are sealed in a byte channel of the phone's pair session for that route
//! (`Channel::route`: its own keys and counters, bound to the 16 byte route id), sent by the phone
//! on the route's `up` relay route and by the hub on `down`. A frame sealed for anything else does
//! not open there. The hub keeps sizes and times only, never a payload.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use crate::hub::{lock, now_ms};
use crate::pair_session as ps;
use crate::remote::{PeerKind, RemotePairing};
use crate::roles::Role;
use crate::rpc::{Bridge, RpcError};

/// Partner routes open at once on one hub, over every partner app. The relay caps each account too.
pub(crate) const MAX_ROUTES: usize = 4;
/// Largest payload in one `relay.partnerRoute.send`, before sealing and base64.
pub(crate) const MAX_CHUNK: usize = 256 * 1024;
/// How long `relay.partnerRoute.open` waits for the relay to accept the route.
const OPEN_TIMEOUT: Duration = Duration::from_secs(10);
const ID_BYTES: usize = 16;

/// The partner app a paired phone belongs to, when it is a partner phone: the name it paired under
/// (bound into the pairing by packages/pair). The name is a label the app chose, not proof of who
/// made it, so routes never go by it: see [`linked_key`].
pub(crate) fn partner_phone_app(p: &RemotePairing) -> Option<&str> {
    if p.kind == PeerKind::Phone {
        p.partner.as_deref()
    } else {
        None
    }
}

/// The partner app key (client id) the person linked this partner phone to in Devices. Only the
/// connection holding that key opens routes to the phone.
pub(crate) fn linked_key(p: &RemotePairing) -> Option<&str> {
    partner_phone_app(p)?;
    p.partner_client.as_deref()
}

type Answer = Result<(), (String, String)>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Waiting for the relay to accept it (first open, or again after the relay connection came back).
    Opening,
    Open,
}

impl State {
    fn as_str(self) -> &'static str {
        match self {
            Self::Opening => "opening",
            Self::Open => "open",
        }
    }
}

struct Route {
    id: String,
    id_bytes: [u8; ID_BYTES],
    app: String,
    /// The partner app key that opened it, which the phone must stay linked to.
    client: String,
    pairing_id: String,
    /// Relay routes: `up` from the phone, `down` to it. Only the phone learns them, in its session.
    up: String,
    down: String,
    /// The partner connection that opened it, which alone sends on it and hears its bytes.
    conn: u64,
    tx: mpsc::UnboundedSender<Message>,
    state: State,
    waiter: Option<oneshot::Sender<Answer>>,
    opened_at: u64,
    last_at: u64,
    /// Payload bytes from the phone, and to it.
    bytes_in: u64,
    bytes_out: u64,
    /// Frames on `up` that were not this route's chunk (another session's, or anything else).
    refused: u64,
}

/// The hub's partner routes, by route id.
#[derive(Default)]
pub(crate) struct Routes(StdMutex<HashMap<String, Route>>);

/// What the relay loop does with partner routes.
pub(crate) enum Cmd {
    /// Ask the relay to open the route's relay routes.
    Open(String),
    /// Seal a chunk for the phone and send it on `down`; answers once it is on its way.
    Send(String, Vec<u8>, oneshot::Sender<Answer>),
    /// The route is gone here: tell the relay and the phone.
    Closed {
        route_id: String,
        up: String,
        pairing_id: String,
        reason: &'static str,
        /// False when the relay closed it and already knows.
        tell_relay: bool,
    },
}

/// The phone side of the relay loop: its pair sessions.
pub(crate) trait Phones {
    /// An event to every live session of a pairing.
    fn event(&mut self, pairing_id: &str, event: &str, data: Value);
    /// Seals `plain` in the route's byte channel of the pairing's newest live session, as a data
    /// frame for the wire.
    fn seal(&mut self, pairing_id: &str, route_id: &[u8], plain: &[u8]) -> Option<String>;
    /// Opens a data frame sealed in the route's byte channel of one of the pairing's sessions.
    fn open(&mut self, pairing_id: &str, route_id: &[u8], body: &str) -> Option<Vec<u8>>;
}

fn random<const N: usize>() -> Option<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).ok()?;
    Some(b)
}

fn event(tx: &mpsc::UnboundedSender<Message>, name: &str, data: &Value) {
    let _ = tx.send(Message::text(json!({ "event": name, "data": data }).to_string()));
}

/// Tells the app (Settings, Devices) that the list changed. Ids and names only.
fn changed(b: &Bridge, route_id: &str, app: &str, state: &str) {
    b.hub.emit(
        "partnerRoute.changed",
        json!({ "routeId": route_id, "app": app, "state": state }),
    );
}

impl Routes {
    fn row(r: &Route, phone: Option<&str>) -> Value {
        json!({
            "routeId": r.id,
            "app": r.app,
            "pairingId": r.pairing_id,
            "phone": phone,
            "state": r.state.as_str(),
            "openedAt": r.opened_at,
            "lastAt": r.last_at,
            "bytesIn": r.bytes_in,
            "bytesOut": r.bytes_out,
            "refused": r.refused,
        })
    }

    /// The relay routes of every route, for the relay connection to open again after it reconnects.
    /// Each goes back to opening until the relay accepts it.
    pub(crate) fn reopen(&self) -> Vec<String> {
        let mut out = Vec::new();
        for r in lock(&self.0).values_mut() {
            r.state = State::Opening;
            out.push(json!({ "op": "partner.open", "up": r.up, "down": r.down }).to_string());
            out.push(json!({ "op": "sub", "route": r.up }).to_string());
        }
        out
    }

    fn is_up(&self, route: &str) -> bool {
        lock(&self.0).values().any(|r| r.up == route)
    }

    /// Removes a route by id, or by its `up` or `down` relay route.
    fn take(&self, key: &str) -> Option<Route> {
        let mut m = lock(&self.0);
        let id = m
            .values()
            .find(|r| r.id == key || r.up == key || r.down == key)
            .map(|r| r.id.clone())?;
        m.remove(&id)
    }
}

/// Removes a route and tells its desktop and the app; the relay (unless it closed the route itself)
/// and the phone hear it through the relay loop when one runs.
fn close(b: &Bridge, key: &str, reason: &'static str) -> bool {
    close_as(b, key, reason, true)
}

fn close_as(b: &Bridge, key: &str, reason: &'static str, tell_relay: bool) -> bool {
    let Some(r) = b.remote.partners.take(key) else {
        return false;
    };
    event(
        &r.tx,
        "partnerRoute.closed",
        &json!({ "routeId": r.id, "reason": reason }),
    );
    if let Some(w) = r.waiter {
        let _ = w.send(Err((
            "closed".to_owned(),
            format!("the partner route closed ({reason})"),
        )));
    }
    changed(b, &r.id, &r.app, "closed");
    b.remote.partner_cmd(Cmd::Closed {
        route_id: r.id,
        up: r.up,
        pairing_id: r.pairing_id,
        reason,
        tell_relay,
    });
    true
}

/// A partner connection ended: its routes close.
pub(crate) fn conn_closed(b: &Bridge, conn: u64) {
    let ids: Vec<String> = lock(&b.remote.partners.0)
        .values()
        .filter(|r| r.conn == conn)
        .map(|r| r.id.clone())
        .collect();
    for id in ids {
        close(b, &id, "desktop_gone");
    }
}

/// Pairings changed: routes whose phone is no longer a partner phone of their app close.
pub(crate) fn pairings_changed(b: &Bridge) {
    let ids: Vec<String> = lock(&b.remote.partners.0)
        .values()
        .filter(|r| {
            b.remote
                .pairing(&r.pairing_id)
                .is_none_or(|p| linked_key(&p) != Some(r.client.as_str()))
        })
        .map(|r| r.id.clone())
        .collect();
    for id in ids {
        close(b, &id, "unpaired");
    }
}

/// Remote access went off: every route closes.
pub(crate) fn close_all(b: &Bridge, reason: &'static str) {
    let ids: Vec<String> = lock(&b.remote.partners.0).keys().cloned().collect();
    for id in ids {
        close(b, &id, reason);
    }
}

/// The phones the person linked to this very key in Devices (one, with `wanted`); a matching name is
/// not enough.
fn linked_phones(b: &Bridge, client: &str, wanted: Option<&str>) -> Vec<String> {
    b.remote
        .pairings()
        .into_iter()
        .filter(|x| linked_key(x) == Some(client))
        .map(|x| x.pairing_id)
        .filter(|id| wanted.is_none_or(|w| w == id))
        .collect()
}

/// Who is calling `relay.partnerRoute.*`.
pub(crate) struct Caller<'a> {
    pub conn: u64,
    pub role: Role,
    /// The partner app's name, from its key.
    pub partner: Option<&'a str>,
    /// The partner app key's client id.
    pub client: Option<&'a str>,
    pub tx: &'a mpsc::UnboundedSender<Message>,
}

pub(crate) async fn call(
    b: &Arc<Bridge>,
    who: &Caller<'_>,
    method: &str,
    p: &Value,
) -> Result<Value, RpcError> {
    match method {
        "relay.partnerRoute.list" => Ok(list(b, who)),
        "relay.partnerRoute.open" => open(b, who, p).await,
        "relay.partnerRoute.send" => send(b, who, p).await,
        "relay.partnerRoute.close" => {
            let id: String = crate::rpc::arg(p, "routeId")?;
            let app = lock(&b.remote.partners.0).get(&id).map(|r| r.app.clone());
            let Some(app) = app else {
                return Err(RpcError::new("not_found", "no such partner route"));
            };
            // The person (the app) closes any route; a partner app closes its own.
            if !(who.role == Role::App || who.partner == Some(app.as_str())) {
                return Err(RpcError::new(
                    "forbidden",
                    "only the app or the partner that opened it closes a partner route",
                ));
            }
            let reason = if who.role == Role::App {
                "closed_by_owner"
            } else {
                "closed"
            };
            Ok(json!({ "closed": close(b, &id, reason) }))
        }
        _ => Err(RpcError::new("not_found", format!("unknown method {method}"))),
    }
}

/// `relay.partnerRoute.list`: open routes with their sizes and times, and the caps. The app and
/// agents see every route, a partner app its own. The relay routes themselves are never listed.
fn list(b: &Bridge, who: &Caller<'_>) -> Value {
    let rows: Vec<Value> = lock(&b.remote.partners.0)
        .values()
        .filter(|r| who.partner.is_none_or(|a| a == r.app))
        .map(|r| {
            let phone = b
                .remote
                .pairing(&r.pairing_id)
                .and_then(|p| p.peer.get("name").and_then(Value::as_str).map(str::to_owned));
            Routes::row(r, phone.as_deref())
        })
        .collect();
    let relay = b.remote.quota().and_then(|q| q.get("partner").cloned());
    json!({
        "routes": rows,
        "caps": {
            "maxRoutes": MAX_ROUTES,
            "maxChunkBytes": MAX_CHUNK,
            "relay": relay,
        },
    })
}

/// `relay.partnerRoute.open {app, pairingId?}`: a partner app opens a route to its own phone.
async fn open(b: &Arc<Bridge>, who: &Caller<'_>, p: &Value) -> Result<Value, RpcError> {
    let Some(partner) = who.partner else {
        return Err(RpcError::new(
            "forbidden",
            "partner routes are for partner apps, with their partner key",
        ));
    };
    let app: String = crate::rpc::arg(p, "app")?;
    if app != partner {
        return Err(RpcError::new(
            "forbidden",
            "a partner app opens routes only for itself",
        ));
    }
    let Some(client) = who.client else {
        return Err(RpcError::new(
            "forbidden",
            "partner routes need a remembered partner key",
        ));
    };
    let phones = linked_phones(b, client, p.get("pairingId").and_then(Value::as_str));
    let pairing_id = match phones.as_slice() {
        [one] => one.clone(),
        [] => {
            return Err(RpcError::new(
                "not_found",
                format!(
                    "no {partner} phone is linked to this key; the person links one in Settings, Printer bridge, Devices"
                ),
            ));
        }
        _ => {
            return Err(RpcError::new(
                "bad_request",
                "more than one phone is paired for this app; say which with pairingId",
            ));
        }
    };
    if !b.remote.running() {
        return Err(RpcError::new("not_supported", "remote access is off on this hub"));
    }
    let (Some(id_bytes), Some(up), Some(down)) = (random::<ID_BYTES>(), random::<32>(), random::<32>())
    else {
        return Err(RpcError::new("failed", "no randomness"));
    };
    let id = ps::b64(&id_bytes);
    let (done, wait) = oneshot::channel();
    {
        let mut m = lock(&b.remote.partners.0);
        if m.len() >= MAX_ROUTES {
            return Err(RpcError::new(
                "rate_limited",
                format!("{MAX_ROUTES} partner routes are open on this hub already"),
            ));
        }
        let now = now_ms();
        m.insert(
            id.clone(),
            Route {
                id: id.clone(),
                id_bytes,
                app: partner.to_owned(),
                client: client.to_owned(),
                pairing_id: pairing_id.clone(),
                up: format!("pr:{}", ps::b64(&up)),
                down: format!("pr:{}", ps::b64(&down)),
                conn: who.conn,
                tx: who.tx.clone(),
                state: State::Opening,
                waiter: Some(done),
                opened_at: now,
                last_at: now,
                bytes_in: 0,
                bytes_out: 0,
                refused: 0,
            },
        );
    }
    b.remote.partner_cmd(Cmd::Open(id.clone()));
    match tokio::time::timeout(OPEN_TIMEOUT, wait).await {
        Ok(Ok(Ok(()))) => {
            Ok(json!({ "routeId": id, "app": partner, "pairingId": pairing_id, "state": "open" }))
        }
        Ok(Ok(Err((code, message)))) => Err(RpcError::new(&code, message)),
        _ => {
            close(b, &id, "relay_timeout");
            Err(RpcError::new(
                "unavailable",
                "the relay did not open the route; try again when the hub is connected",
            ))
        }
    }
}

/// `relay.partnerRoute.send {routeId, data}`: base64 bytes from the desktop to the phone.
async fn send(b: &Arc<Bridge>, who: &Caller<'_>, p: &Value) -> Result<Value, RpcError> {
    use base64::Engine as _;
    let id: String = crate::rpc::arg(p, "routeId")?;
    let text: String = crate::rpc::arg(p, "data")?;
    if text.len() > MAX_CHUNK.div_ceil(3) * 4 + 4 {
        return Err(RpcError::new(
            "too_large",
            format!("a chunk is at most {MAX_CHUNK} bytes"),
        ));
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(text.as_bytes())
        .map_err(|_| RpcError::new("bad_request", "data is base64"))?;
    if data.len() > MAX_CHUNK {
        return Err(RpcError::new(
            "too_large",
            format!("a chunk is at most {MAX_CHUNK} bytes"),
        ));
    }
    {
        let m = lock(&b.remote.partners.0);
        let Some(r) = m.get(&id).filter(|r| r.conn == who.conn) else {
            return Err(RpcError::new(
                "not_found",
                "no such partner route on this connection",
            ));
        };
        if r.state != State::Open {
            return Err(RpcError::new(
                "busy",
                "the partner route is opening; try again shortly",
            ));
        }
    }
    let n = data.len();
    let (done, wait) = oneshot::channel();
    b.remote.partner_cmd(Cmd::Send(id, data, done));
    match tokio::time::timeout(OPEN_TIMEOUT, wait).await {
        Ok(Ok(Ok(()))) => Ok(json!({ "sent": n })),
        Ok(Ok(Err((code, message)))) => Err(RpcError::new(&code, message)),
        _ => Err(RpcError::new(
            "unavailable",
            "the hub is not connected to the relay",
        )),
    }
}

/// One command, inside the relay loop.
pub(crate) fn on_cmd(b: &Bridge, cmd: Cmd, phones: &mut dyn Phones, outgoing: &mut Vec<String>) {
    match cmd {
        Cmd::Open(id) => {
            if let Some(r) = lock(&b.remote.partners.0).get(&id) {
                outgoing.push(json!({ "op": "partner.open", "up": r.up, "down": r.down }).to_string());
                outgoing.push(json!({ "op": "sub", "route": r.up }).to_string());
            }
        }
        Cmd::Send(id, data, done) => {
            let target = lock(&b.remote.partners.0)
                .get(&id)
                .filter(|r| r.state == State::Open)
                .map(|r| (r.pairing_id.clone(), r.down.clone(), r.id_bytes));
            let Some((pairing_id, down, id_bytes)) = target else {
                let _ = done.send(Err(("not_found".to_owned(), "no such partner route".to_owned())));
                return;
            };
            let Some(body) = phones.seal(&pairing_id, &id_bytes, &data) else {
                let _ = done.send(Err((
                    "not_connected".to_owned(),
                    "the phone is not connected; it opens a session when the partner app runs".to_owned(),
                )));
                return;
            };
            outgoing.push(json!({ "op": "send", "to": down, "body": body }).to_string());
            if let Some(r) = lock(&b.remote.partners.0).get_mut(&id) {
                r.bytes_out += data.len() as u64;
                r.last_at = now_ms();
            }
            let _ = done.send(Ok(()));
        }
        Cmd::Closed {
            route_id,
            up,
            pairing_id,
            reason,
            tell_relay,
        } => {
            if tell_relay {
                outgoing.push(json!({ "op": "partner.close", "up": up }).to_string());
            }
            outgoing.push(json!({ "op": "unsub", "route": up }).to_string());
            phones.event(
                &pairing_id,
                "partnerRoute.closed",
                json!({ "routeId": route_id, "reason": reason }),
            );
        }
    }
}

/// A relay frame about partner routes. True when it was one (and is handled).
pub(crate) fn on_relay(b: &Bridge, msg: &Value, phones: &mut dyn Phones) -> bool {
    let op = msg.get("op").and_then(Value::as_str).unwrap_or("");
    let route = msg.get("route").and_then(Value::as_str);
    match op {
        "msg" if route.is_some_and(|r| b.remote.partners.is_up(r)) => {
            if let (Some(r), Some(body)) = (route, msg.get("body").and_then(Value::as_str)) {
                on_chunk(b, r, body, phones);
            }
            true
        }
        "partner.open" => {
            let up = msg.get("up").and_then(Value::as_str).unwrap_or("");
            let opened = {
                let mut m = lock(&b.remote.partners.0);
                m.values_mut().find(|r| r.up == up).map(|r| {
                    r.state = State::Open;
                    if let Some(w) = r.waiter.take() {
                        let _ = w.send(Ok(()));
                    }
                    (r.id.clone(), r.app.clone(), r.pairing_id.clone(), r.down.clone())
                })
            };
            if let Some((id, app, pairing_id, down)) = opened {
                // The phone learns the relay routes here, sealed in its session, every time the
                // relay opens them (again after a reconnect, when it must subscribe again).
                phones.event(
                    &pairing_id,
                    "partnerRoute.opened",
                    json!({ "routeId": id, "app": app, "up": up, "down": down }),
                );
                changed(b, &id, &app, "open");
            }
            true
        }
        "partner.closed" => {
            if let Some(r) = route {
                let reason = match msg.get("reason").and_then(Value::as_str) {
                    Some("idle") => "idle",
                    Some("route_cap") => "route_cap",
                    Some("account_cap") => "account_cap",
                    Some("signed_out") => "signed_out",
                    _ => "relay_closed",
                };
                close_as(b, r, reason, false);
            }
            true
        }
        "error" if route.is_some_and(is_partner_route) => {
            let Some(r) = route else { return true };
            let code = msg
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("failed")
                .to_owned();
            let message = msg
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("the relay refused the route")
                .to_owned();
            // A refused open (or reopen) ends the route; a refused send on an open route is followed
            // by `partner.closed` when the relay closes it.
            let refused_open = {
                let mut m = lock(&b.remote.partners.0);
                m.values_mut()
                    .find(|x| (x.up == r || x.down == r) && x.state == State::Opening)
                    .map(|x| {
                        if let Some(w) = x.waiter.take() {
                            let _ = w.send(Err((code.clone(), message.clone())));
                        }
                        x.id.clone()
                    })
            };
            if let Some(id) = refused_open {
                close(b, &id, "relay_refused");
            }
            true
        }
        _ => false,
    }
}

pub(crate) fn is_partner_route(route: &str) -> bool {
    route.starts_with("pr:")
}

/// A sealed chunk from the phone on a route's `up`. Anything that does not open in the route's byte
/// channel (a request envelope sealed for the session, another route's chunk, a replay) is refused
/// and counted, and never reaches a hub method.
fn on_chunk(b: &Bridge, up: &str, body: &str, phones: &mut dyn Phones) {
    use base64::Engine as _;
    let target = lock(&b.remote.partners.0)
        .values()
        .find(|r| r.up == up && r.state == State::Open)
        .map(|r| (r.id.clone(), r.pairing_id.clone(), r.id_bytes));
    let Some((id, pairing_id, id_bytes)) = target else {
        return;
    };
    let plain = phones.open(&pairing_id, &id_bytes, body);
    let mut m = lock(&b.remote.partners.0);
    let Some(r) = m.get_mut(&id) else { return };
    let Some(payload) = plain.as_deref() else {
        r.refused += 1;
        return;
    };
    r.bytes_in += payload.len() as u64;
    r.last_at = now_ms();
    event(
        &r.tx,
        "partnerRoute.data",
        &json!({ "routeId": id, "data": base64::engine::general_purpose::STANDARD.encode(payload) }),
    );
}

/// `partnerRoute.list` for a paired phone: its app's open routes, with the relay routes to use.
pub(crate) fn phone_list(b: &Bridge, pairing: &RemotePairing) -> Option<Value> {
    partner_phone_app(pairing)?;
    let rows: Vec<Value> = lock(&b.remote.partners.0)
        .values()
        .filter(|r| r.pairing_id == pairing.pairing_id && r.state == State::Open)
        .map(|r| json!({ "routeId": r.id, "app": r.app, "up": r.up, "down": r.down }))
        .collect();
    Some(Value::Array(rows))
}
