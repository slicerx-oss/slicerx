// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Remote access: the hub answers paired phones and remote agents over the hosted relay, with the
//! app closed. The app hands the hub each pairing it wants reachable (`remote.pairings.put`), the
//! hub subscribes that pairing's host route on the relay, accepts sessions with the pairing
//! protocol (`pair_session`), and serves the remote method subset (`remote_rpc`).
//!
//! The relay sees routes and sealed frames only. Device keys live in the secret store (the
//! keychain on macOS), never in `remote.json`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sx_connect::SecretStore;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use crate::hub::{StateDir, lock};
use crate::pair_session::{self as ps, Channel, SessionFrame};
use crate::rpc::Bridge;

pub(crate) const REMOTE_FILE: &str = "remote.json";
const KEY_PREFIX: &str = "remote-key:";
/// The relay token the app hands over for the relay's account tier. Secret store only.
const TOKEN_SECRET: &str = "remote-relay-token";
/// The app identity's static X25519 secret, which session keys mix in (session version 2).
const HOST_DH_SECRET: &str = "remote-host-dh";
/// The only audience the hub sends to a relay: a short-lived token minted for the relay alone, never
/// the account's own session (which works against the whole backend).
pub(crate) const RELAY_AUDIENCE: &str = "sx-relay";
/// Session ids a pairing used recently, so a replayed init cannot open a session again.
const SEEN_SESSIONS_MS: u64 = 60 * 60 * 1000;
const MAX_SEEN_SESSIONS: usize = 4096;
/// Sessions at once, over all pairings.
const MAX_SESSIONS: usize = 64;
/// Sessions at once per pairing; a new one closes the oldest.
const SESSIONS_PER_PAIRING: usize = 2;
const MAX_PAIRINGS: usize = 64;
const RELAY_FRAME_LIMIT: usize = 2 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PeerKind {
    Phone,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub(crate) struct Rights {
    #[serde(default)]
    pub request: bool,
    #[serde(default)]
    pub approve: bool,
}

/// One pairing the hub answers on the relay. The device key is in the secret store.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemotePairing {
    pub pairing_id: String,
    pub kind: PeerKind,
    /// The peer's public identity (`PublicIdentity` in packages/pair), for signed decisions.
    pub peer: Value,
    pub rights: Rights,
    pub added_at: u64,
    /// The remembered client (`clients.create` with `remote: true`) this agent pairing belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// The app that added this phone ([`owner_of`]), so one app's sync never removes another
    /// app's phones. `None` for pairings from before tags: the first app that lists one claims it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

/// Who an app connection is, for tagging the phones it pairs: the remembered client it paired as,
/// or else the `appId` it sends (a random id the app keeps for its install).
pub(crate) fn owner_of(client: Option<&str>, p: &Value) -> Option<String> {
    client.map(|c| format!("client:{c}")).or_else(|| {
        p.get("appId")
            .and_then(Value::as_str)
            .filter(|a| {
                !a.is_empty()
                    && a.len() <= 64
                    && a.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
            })
            .map(|a| format!("app:{a}"))
    })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    enabled: bool,
    relay: Option<String>,
    /// The app's pair identity (public part), which phones pinned at pairing.
    host: Option<Value>,
    /// STUN server (`host:port`) for the hub's public address in direct video.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stun: Option<String>,
    pairings: Vec<RemotePairing>,
}

#[derive(Debug, Clone, Default)]
struct Status {
    connected: bool,
    sessions: usize,
    last_error: Option<String>,
    /// The relay accepted the account session on this connection.
    signed_in: bool,
    /// The relay's last `quota` answer.
    quota: Option<Value>,
}

enum Cmd {
    /// Pairings changed: subscribe new routes, drop removed ones and their sessions.
    Pairings,
    Quota,
    /// The app handed over a new account session, or took it back.
    Token,
}

/// The last still of one printer for remote requests, with the time it was taken.
pub(crate) type StillSlot = Arc<tokio::sync::Mutex<Option<(u64, Option<crate::watch::Still>)>>>;

pub(crate) struct Remote {
    saved: StdMutex<Saved>,
    keys: StdMutex<HashMap<String, [u8; 32]>>,
    /// The host identity's static X25519 secret (`hostDh` in `remote.configure`).
    host_dh: StdMutex<Option<[u8; 32]>>,
    status: StdMutex<Status>,
    runner: StdMutex<Option<(JoinHandle<()>, mpsc::UnboundedSender<Cmd>)>>,
    rtc_bind: StdMutex<Option<std::net::IpAddr>>,
    stills: StdMutex<HashMap<String, StillSlot>>,
}

fn valid_relay_url(url: &str) -> bool {
    if url.len() > 200 {
        return false;
    }
    if url.starts_with("wss://") {
        return true;
    }
    // Plain ws only to this machine, for a relay run locally in tests.
    url.strip_prefix("ws://")
        .and_then(|r| r.split(['/', ':']).next())
        .is_some_and(|h| matches!(h, "127.0.0.1" | "localhost" | "[::1]"))
}

impl Remote {
    pub(crate) fn load(dir: Option<&StateDir>, secrets: &dyn SecretStore) -> Self {
        let saved: Saved = dir.and_then(|d| d.load(REMOTE_FILE)).unwrap_or_default();
        let mut keys = HashMap::new();
        for p in &saved.pairings {
            if let Some(k) = secrets
                .get(&format!("{KEY_PREFIX}{}", p.pairing_id))
                .and_then(|t| ps::unb64(&t))
                .and_then(|b| <[u8; 32]>::try_from(b).ok())
            {
                keys.insert(p.pairing_id.clone(), k);
            }
        }
        let host_dh = secrets
            .get(HOST_DH_SECRET)
            .and_then(|t| ps::unb64(&t))
            .and_then(|b| <[u8; 32]>::try_from(b).ok());
        Self {
            saved: StdMutex::new(saved),
            keys: StdMutex::new(keys),
            host_dh: StdMutex::new(host_dh),
            status: StdMutex::new(Status::default()),
            runner: StdMutex::new(None),
            rtc_bind: StdMutex::new(None),
            stills: StdMutex::new(HashMap::new()),
        }
    }

    /// The still cache slot of one printer (known printers only, so the map stays small).
    pub(crate) fn still_slot(&self, printer: &str) -> StillSlot {
        lock(&self.stills).entry(printer.to_owned()).or_default().clone()
    }

    /// The relay's last `quota` answer.
    pub(crate) fn quota(&self) -> Option<Value> {
        lock(&self.status).quota.clone()
    }

    pub(crate) fn pairing(&self, id: &str) -> Option<RemotePairing> {
        lock(&self.saved)
            .pairings
            .iter()
            .find(|p| p.pairing_id == id)
            .cloned()
    }

    pub(crate) fn set_rtc_bind(&self, ip: Option<std::net::IpAddr>) {
        *lock(&self.rtc_bind) = ip;
    }

    pub(crate) fn rtc_bind(&self) -> Option<std::net::IpAddr> {
        *lock(&self.rtc_bind)
    }

    pub(crate) fn stun(&self) -> Option<String> {
        lock(&self.saved).stun.clone()
    }

    pub(crate) fn host_identity(&self) -> Option<Value> {
        lock(&self.saved).host.clone()
    }

    fn persist(b: &Bridge) {
        let Some(dir) = &b.hub.dir else { return };
        let saved = lock(&b.remote.saved).clone();
        if let Err(e) = dir.save(REMOTE_FILE, &saved) {
            eprintln!("sx-link: could not save {REMOTE_FILE}: {e}");
        }
    }

    fn send(&self, cmd: Cmd) {
        if let Some((_, tx)) = lock(&self.runner).as_ref() {
            let _ = tx.send(cmd);
        }
    }
}

/// Starts the relay connection if remote access was on when the hub stopped.
pub(crate) fn resume(b: &Arc<Bridge>) {
    let on = {
        let s = lock(&b.remote.saved);
        s.enabled && s.relay.is_some()
    };
    if on {
        restart(b);
    }
}

fn restart(b: &Arc<Bridge>) {
    let mut runner = lock(&b.remote.runner);
    if let Some((h, _)) = runner.take() {
        h.abort();
    }
    *lock(&b.remote.status) = Status::default();
    let (enabled, relay) = {
        let s = lock(&b.remote.saved);
        (s.enabled, s.relay.clone())
    };
    if let (true, Some(url)) = (enabled, relay) {
        let (tx, rx) = mpsc::unbounded_channel();
        let h = tokio::spawn(run(b.clone(), url, rx));
        *runner = Some((h, tx));
    }
}

/// The `remote.*` methods, for the app only.
/// `remote.configure`: the relay, STUN server and host identity, and whether remote access is on.
fn configure(b: &Arc<Bridge>, p: &Value) -> Result<Value, crate::rpc::RpcError> {
    use crate::rpc::{RpcError, arg};
    let enabled: bool = arg(p, "enabled")?;
    {
        let mut s = lock(&b.remote.saved);
        if let Some(url) = p.get("relay").and_then(Value::as_str) {
            if !valid_relay_url(url) {
                return Err(RpcError::new("bad_request", "relay must be a wss:// URL"));
            }
            s.relay = Some(url.to_owned());
        }
        match p.get("stun") {
            Some(Value::String(st)) if st.len() <= 200 && st.contains(':') => {
                s.stun = Some(st.clone());
            }
            Some(Value::Null) => s.stun = None,
            Some(_) => return Err(RpcError::new("bad_request", "stun is host:port")),
            None => {}
        }
        if let Some(h) = p.get("host") {
            if !valid_identity(h) {
                return Err(RpcError::new("bad_request", "host is not a public identity"));
            }
            s.host = Some(h.clone());
        }
        set_host_dh(b, s.host.as_ref(), p.get("hostDh"), enabled)?;
        if enabled && (s.relay.is_none() || s.host.is_none()) {
            return Err(RpcError::new(
                "bad_request",
                "remote access needs a relay and the host identity",
            ));
        }
        s.enabled = enabled;
    }
    Remote::persist(b);
    restart(b);
    Ok(status(b))
}

/// `remote.pairings.put`: saves a paired phone or agent and its key. Agents never get the approve right.
fn put_pairing(b: &Arc<Bridge>, p: &Value, owner: Option<String>) -> Result<Value, crate::rpc::RpcError> {
    use crate::rpc::{RpcError, arg};
    let pairing_id: String = arg(p, "pairingId")?;
    let key_text: String = arg(p, "deviceKey")?;
    let kind: PeerKind = arg(p, "kind")?;
    let peer: Value = arg(p, "peer")?;
    let rights: Rights = p
        .get("rights")
        .map_or(Ok(Rights::default()), |r| serde_json::from_value(r.clone()))
        .map_err(|_| RpcError::new("bad_request", "rights is malformed"))?;
    if pairing_id.len() != 22 || ps::unb64(&pairing_id).is_none_or(|b| b.len() != 16) {
        return Err(RpcError::new("bad_request", "pairingId is malformed"));
    }
    let key: [u8; 32] = ps::unb64(&key_text)
        .and_then(|k| k.try_into().ok())
        .ok_or_else(|| RpcError::new("bad_request", "deviceKey is malformed"))?;
    if !valid_identity(&peer) {
        return Err(RpcError::new("bad_request", "peer is not a public identity"));
    }
    // Agents never get the approve right over the relay: a person answers cards.
    let rights = if kind == PeerKind::Agent {
        Rights {
            approve: false,
            ..rights
        }
    } else {
        rights
    };
    {
        let s = lock(&b.remote.saved);
        if s.pairings.len() >= MAX_PAIRINGS && !s.pairings.iter().any(|x| x.pairing_id == pairing_id) {
            return Err(RpcError::new("rate_limited", "too many remote pairings"));
        }
    }
    b.secrets()
        .set(&format!("{KEY_PREFIX}{pairing_id}"), &ps::b64(&key))
        .map_err(|e| RpcError::new("failed", e.to_string()))?;
    lock(&b.remote.keys).insert(pairing_id.clone(), key);
    {
        let mut s = lock(&b.remote.saved);
        s.pairings.retain(|x| x.pairing_id != pairing_id);
        let owner = if kind == PeerKind::Phone { owner } else { None };
        s.pairings.push(RemotePairing {
            pairing_id,
            kind,
            peer,
            rights,
            added_at: crate::hub::now_ms(),
            client_id: None,
            owner,
        });
    }
    Remote::persist(b);
    b.remote.send(Cmd::Pairings);
    Ok(json!({ "saved": true }))
}

pub(crate) fn call(
    b: &Arc<Bridge>,
    method: &str,
    p: &Value,
    owner: Option<String>,
) -> Result<Value, crate::rpc::RpcError> {
    use crate::rpc::{RpcError, arg};
    match method {
        "remote.status" => Ok(status(b)),
        "remote.configure" => configure(b, p),
        "remote.pairings.list" => Ok(json!(lock(&b.remote.saved).pairings)),
        "remote.pairings.put" => put_pairing(b, p, owner),
        "remote.pairings.remove" => {
            let pairing_id: String = arg(p, "pairingId")?;
            let removed = {
                let mut s = lock(&b.remote.saved);
                let before = s.pairings.len();
                s.pairings.retain(|x| x.pairing_id != pairing_id);
                before != s.pairings.len()
            };
            forget_key(b, &pairing_id)?;
            Remote::persist(b);
            b.remote.send(Cmd::Pairings);
            Ok(json!({ "removed": removed }))
        }
        // The app's full list of phone pairings. Every phone pairing the hub holds that is not in it
        // is removed, so a phone unpaired while the hub could not be reached is gone at the next
        // connection. Agent pairings belong to the hub's clients and are left alone.
        "remote.pairings.sync" => sync_pairings(b, p, owner.as_deref()),
        // A relay token (audience sx-relay, minted for the account by the backend) for the relay's
        // account tier: kept in the secret store, refreshed by the app before it expires, never
        // logged or returned. `token: null` signs the hub out; it then uses the anonymous tier.
        "remote.token" => set_token(b, p),
        "remote.quota" => {
            b.remote.send(Cmd::Quota);
            Ok(status(b))
        }
        _ => Err(RpcError::new("not_found", format!("unknown method {method}"))),
    }
}

/// `remote.pairings.sync {pairingIds, appId?}`: the calling app's full list of phone pairings. Every
/// phone pairing this app added that is not in it is removed, so a phone unpaired while the hub could
/// not be reached is gone at the next connection. Phones another app added, and agent pairings, are
/// left alone. A pairing from before tags is claimed by the app that lists it and otherwise kept
/// (only an explicit remove or `removeAll` takes it). An empty list removes this app's phones only
/// with `removeAll: true`: a pair store that did not open reads as no phones, and must not unpair
/// them all (N3).
fn sync_pairings(b: &Arc<Bridge>, p: &Value, owner: Option<&str>) -> Result<Value, crate::rpc::RpcError> {
    let keep: Vec<String> = crate::rpc::arg(p, "pairingIds")?;
    let remove_all = p.get("removeAll").and_then(Value::as_bool) == Some(true);
    let gone: Vec<String> = {
        let mut s = lock(&b.remote.saved);
        let mine = |x: &RemotePairing| x.kind == PeerKind::Phone && x.owner.as_deref() == owner;
        let untagged = |x: &RemotePairing| x.kind == PeerKind::Phone && x.owner.is_none();
        if keep.is_empty() && !remove_all && s.pairings.iter().any(|x| mine(x) || untagged(x)) {
            return Err(crate::rpc::RpcError::new(
                "bad_request",
                "an empty list would remove every phone; send removeAll: true to mean that",
            ));
        }
        // Untagged phones this app lists are its own from now on.
        if owner.is_some() {
            for x in &mut s.pairings {
                if untagged(x) && keep.contains(&x.pairing_id) {
                    x.owner = owner.map(str::to_owned);
                }
            }
        }
        let drop =
            |x: &RemotePairing| !keep.contains(&x.pairing_id) && (mine(x) || (remove_all && untagged(x)));
        let gone = s
            .pairings
            .iter()
            .filter(|x| drop(x))
            .map(|x| x.pairing_id.clone())
            .collect();
        s.pairings.retain(|x| !drop(x));
        gone
    };
    for id in &gone {
        forget_key(b, id)?;
    }
    // Claims change the saved list too.
    Remote::persist(b);
    if !gone.is_empty() {
        b.remote.send(Cmd::Pairings);
    }
    Ok(json!({ "removed": gone }))
}

/// Drops a pairing's device key from memory and the secret store. A key the store could not delete
/// is an error, so the app retries the removal instead of believing it done.
fn forget_key(b: &Bridge, pairing_id: &str) -> Result<(), crate::rpc::RpcError> {
    lock(&b.remote.keys).remove(pairing_id);
    let name = format!("{KEY_PREFIX}{pairing_id}");
    match b.secrets().delete(&name) {
        Ok(()) => Ok(()),
        Err(_) if b.secrets().get(&name).is_none() => Ok(()),
        Err(e) => Err(crate::rpc::RpcError::new("failed", e.to_string())),
    }
}

fn dh_pinned(host: Option<&Value>, secret: &[u8; 32]) -> bool {
    let pinned = host
        .and_then(|h| h.get("dhPub"))
        .and_then(Value::as_str)
        .and_then(ps::unb64);
    pinned.as_deref() == Some(ps::dh_public(secret).as_slice())
}

/// Keeps the host identity's static X25519 secret (`hostDh`), which must be the one behind the
/// `dhPub` phones pinned, or no session would open. Turning remote access on needs one that matches.
fn set_host_dh(
    b: &Bridge,
    host: Option<&Value>,
    t: Option<&Value>,
    enabled: bool,
) -> Result<(), crate::rpc::RpcError> {
    use crate::rpc::RpcError;
    if let Some(t) = t {
        let secret = t
            .as_str()
            .and_then(ps::unb64)
            .and_then(|b| <[u8; 32]>::try_from(b).ok())
            .ok_or_else(|| RpcError::new("bad_request", "hostDh is 32 bytes of base64url"))?;
        if !dh_pinned(host, &secret) {
            return Err(RpcError::new(
                "bad_request",
                "hostDh does not match the host identity's dhPub",
            ));
        }
        b.secrets()
            .set(HOST_DH_SECRET, &ps::b64(&secret))
            .map_err(|e| RpcError::new("failed", e.to_string()))?;
        *lock(&b.remote.host_dh) = Some(secret);
    }
    let kept = lock(&b.remote.host_dh)
        .as_ref()
        .is_some_and(|s| dh_pinned(host, s));
    if enabled && !kept {
        return Err(RpcError::new(
            "bad_request",
            "remote access needs the host identity's key (hostDh); update the app",
        ));
    }
    Ok(())
}

/// A pairing for a remote agent, made with its client key (`clients.create` with `remote: true`).
/// The reply carries the device key once; the agent opens sessions with it over the relay.
pub(crate) fn create_agent(
    b: &Arc<Bridge>,
    client_id: &str,
    name: &str,
) -> Result<Value, crate::rpc::RpcError> {
    use crate::rpc::RpcError;
    let mut raw = [0u8; 16 + 32 + 16];
    getrandom::fill(&mut raw).map_err(|_| RpcError::new("failed", "no randomness"))?;
    let (id_bytes, rest) = raw.split_at(16);
    let (key_bytes, device_bytes) = rest.split_at(32);
    let pairing_id = ps::b64(id_bytes);
    let key: [u8; 32] = key_bytes.try_into().map_err(|_| RpcError::new("failed", "key"))?;
    if lock(&b.remote.saved).pairings.len() >= MAX_PAIRINGS {
        return Err(RpcError::new("rate_limited", "too many remote pairings"));
    }
    b.secrets()
        .set(&format!("{KEY_PREFIX}{pairing_id}"), &ps::b64(&key))
        .map_err(|e| RpcError::new("failed", e.to_string()))?;
    lock(&b.remote.keys).insert(pairing_id.clone(), key);
    // Agents sign nothing: their identity names them and carries no keys at all.
    let peer = json!({
        "deviceId": ps::b64(device_bytes),
        "name": name.chars().take(64).collect::<String>(),
        "platform": "link",
        "signPub": null,
        "dhPub": null,
    });
    let record = RemotePairing {
        pairing_id: pairing_id.clone(),
        kind: PeerKind::Agent,
        peer,
        rights: Rights {
            request: true,
            approve: false,
        },
        added_at: crate::hub::now_ms(),
        client_id: Some(client_id.to_owned()),
        owner: None,
    };
    let (relay, host) = {
        let mut s = lock(&b.remote.saved);
        s.pairings.push(record);
        (s.relay.clone(), s.host.clone())
    };
    Remote::persist(b);
    b.remote.send(Cmd::Pairings);
    Ok(
        json!({ "pairingId": pairing_id, "deviceKey": ps::b64(&key), "relay": relay, "host": host, "hubKey": b.hub_key() }),
    )
}

/// Ends the remote pairing of a revoked client key.
pub(crate) fn revoke_client(b: &Arc<Bridge>, client_id: &str) {
    let gone: Vec<String> = {
        let mut s = lock(&b.remote.saved);
        let gone = s
            .pairings
            .iter()
            .filter(|p| p.client_id.as_deref() == Some(client_id))
            .map(|p| p.pairing_id.clone())
            .collect();
        s.pairings.retain(|p| p.client_id.as_deref() != Some(client_id));
        gone
    };
    if gone.is_empty() {
        return;
    }
    for id in &gone {
        lock(&b.remote.keys).remove(id);
        let _ = b.secrets().delete(&format!("{KEY_PREFIX}{id}"));
    }
    Remote::persist(b);
    b.remote.send(Cmd::Pairings);
}

/// `remote.token {token}`: stores or clears the relay token and tells the relay connection.
fn set_token(b: &Arc<Bridge>, p: &Value) -> Result<Value, crate::rpc::RpcError> {
    use crate::rpc::RpcError;
    let secrets = b.secrets();
    match p.get("token") {
        Some(Value::Null) => {
            let _ = secrets.delete(TOKEN_SECRET);
            // Signed out now, not when the relay next answers.
            set_status(b, |s| s.signed_in = false);
        }
        Some(Value::String(t)) if valid_token(t) => {
            secrets
                .set(TOKEN_SECRET, t)
                .map_err(|e| RpcError::new("failed", e.to_string()))?;
        }
        _ => {
            return Err(RpcError::new(
                "bad_request",
                "token is a relay token (audience sx-relay) or null; the account session never goes to the relay",
            ));
        }
    }
    b.remote.send(Cmd::Token);
    Ok(status(b))
}

/// A JWT's shape (three base64url parts, not too long) whose audience is the relay alone. The relay
/// checks the signature; the hub refuses to carry anything else, such as the account's session.
fn valid_token(t: &str) -> bool {
    use base64::Engine as _;
    let shaped = t.len() <= 4096
        && t.split('.').count() == 3
        && t.split('.').all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        });
    let claims = t
        .split('.')
        .nth(1)
        .and_then(|p| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let aud_ok = match claims.as_ref().and_then(|c| c.get("aud")) {
        Some(Value::String(a)) => a == RELAY_AUDIENCE,
        Some(Value::Array(list)) => {
            list.len() == 1 && list.first().and_then(Value::as_str) == Some(RELAY_AUDIENCE)
        }
        _ => false,
    };
    shaped && aud_ok
}

fn auth_frame(b: &Bridge) -> Option<String> {
    b.secrets()
        .get(TOKEN_SECRET)
        .map(|token| json!({ "op": "auth", "token": token }).to_string())
}

fn valid_identity(v: &Value) -> bool {
    let s = |k: &str, n: usize| {
        v.get(k)
            .and_then(Value::as_str)
            .is_some_and(|t| ps::unb64(t).is_some_and(|b| b.len() == n))
    };
    s("deviceId", 16)
        && s("signPub", 32)
        && s("dhPub", 32)
        && v.get("name")
            .and_then(Value::as_str)
            .is_some_and(|n| !n.is_empty() && n.chars().count() <= 64)
        && v.get("platform").and_then(Value::as_str).is_some()
}

fn status(b: &Bridge) -> Value {
    let s = lock(&b.remote.saved);
    let st = lock(&b.remote.status);
    json!({
        "enabled": s.enabled,
        "relay": s.relay,
        "stun": s.stun,
        "connected": st.connected,
        "sessions": st.sessions,
        "pairings": s.pairings.len(),
        "lastError": st.last_error,
        "signedIn": st.signed_in,
        "quota": st.quota,
    })
}

fn set_status(b: &Bridge, f: impl FnOnce(&mut Status)) {
    f(&mut lock(&b.remote.status));
}

// ---------------------------------------------------------------------------
// The relay connection

async fn run(b: Arc<Bridge>, url: String, mut cmds: mpsc::UnboundedReceiver<Cmd>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        let result = if url.starts_with("wss://") {
            match connect_tls(&url).await {
                Ok(ws) => Some(serve(&b, ws, &mut cmds).await),
                Err(e) => {
                    set_status(&b, |s| s.last_error = Some(e));
                    None
                }
            }
        } else {
            match connect_plain(&url).await {
                Ok(ws) => Some(serve(&b, ws, &mut cmds).await),
                Err(e) => {
                    set_status(&b, |s| s.last_error = Some(e));
                    None
                }
            }
        };
        set_status(&b, |s| {
            s.connected = false;
            s.sessions = 0;
            s.signed_in = false;
        });
        if result == Some(true) {
            backoff = Duration::from_secs(1);
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
}

fn ws_config() -> WebSocketConfig {
    let mut cfg = WebSocketConfig::default();
    cfg.max_message_size = Some(RELAY_FRAME_LIMIT);
    cfg.max_frame_size = Some(RELAY_FRAME_LIMIT);
    cfg
}

fn host_port(url: &str) -> Option<(String, u16)> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split('/').next()?;
    let default = if url.starts_with("wss://") { 443 } else { 80 };
    match authority.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(']') || authority.starts_with('[') => {
            Some((h.trim_matches(['[', ']']).to_owned(), p.parse().ok()?))
        }
        _ => Some((authority.trim_matches(['[', ']']).to_owned(), default)),
    }
}

async fn connect_plain(url: &str) -> Result<WebSocketStream<TcpStream>, String> {
    let (host, port) = host_port(url).ok_or("bad relay URL")?;
    let tcp = tokio::time::timeout(Duration::from_secs(10), TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| "relay timed out".to_owned())?
        .map_err(|e| e.to_string())?;
    let (ws, _) = tokio_tungstenite::client_async_with_config(url, tcp, Some(ws_config()))
        .await
        .map_err(|e| e.to_string())?;
    Ok(ws)
}

async fn connect_tls(
    url: &str,
) -> Result<WebSocketStream<tokio_rustls::client::TlsStream<TcpStream>>, String> {
    use rustls_platform_verifier::BuilderVerifierExt as _;
    let (host, port) = host_port(url).ok_or("bad relay URL")?;
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_platform_verifier()
        .map_err(|e| e.to_string())?
        .with_no_client_auth();
    let name = rustls::pki_types::ServerName::try_from(host.clone()).map_err(|e| e.to_string())?;
    let tcp = tokio::time::timeout(Duration::from_secs(10), TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| "relay timed out".to_owned())?
        .map_err(|e| e.to_string())?;
    let stream = tokio_rustls::TlsConnector::from(Arc::new(tls))
        .connect(name, tcp)
        .await
        .map_err(|e| e.to_string())?;
    let (ws, _) = tokio_tungstenite::client_async_with_config(url, stream, Some(ws_config()))
        .await
        .map_err(|e| e.to_string())?;
    Ok(ws)
}

struct Sess {
    pairing_id: String,
    channel: Channel,
    device_route: String,
    opened: u64,
    /// The device has sent one authenticated data frame on this session. Until then it may be a
    /// replayed init, so it never pushes a live session out.
    proven: bool,
    ctx: Arc<crate::remote_rpc::SessCtx>,
}

impl Drop for Sess {
    fn drop(&mut self) {
        self.ctx.close();
    }
}

/// What the session loop needs to know about one pairing.
struct Routes {
    /// Host route to pairing id.
    by_route: HashMap<String, String>,
    /// Pairing id to (host route, device route).
    by_pairing: HashMap<String, (String, String)>,
}

fn routes(b: &Bridge) -> Routes {
    let keys = lock(&b.remote.keys).clone();
    let ids: Vec<String> = lock(&b.remote.saved)
        .pairings
        .iter()
        .map(|p| p.pairing_id.clone())
        .collect();
    let mut r = Routes {
        by_route: HashMap::new(),
        by_pairing: HashMap::new(),
    };
    for id in ids {
        if let Some(k) = keys.get(&id) {
            let (host, device) = ps::pairing_routes(k);
            r.by_route.insert(host.clone(), id.clone());
            r.by_pairing.insert(id, (host, device));
        }
    }
    r
}

/// Runs one relay connection until it drops. True when it was up long enough to count.
async fn serve<S: AsyncRead + AsyncWrite + Unpin>(
    b: &Arc<Bridge>,
    ws: WebSocketStream<S>,
    cmds: &mut mpsc::UnboundedReceiver<Cmd>,
) -> bool {
    let (mut sink, mut source) = ws.split();
    let started = tokio::time::Instant::now();
    let mut current = routes(b);
    // Sign in first, so `acct:` rules and the account tier apply from the start.
    if let Some(auth) = auth_frame(b)
        && sink.send(Message::text(auth)).await.is_err()
    {
        return false;
    }
    for host in current.by_route.keys() {
        if sink
            .send(Message::text(json!({ "op": "sub", "route": host }).to_string()))
            .await
            .is_err()
        {
            return false;
        }
    }
    let _ = sink.send(Message::text(r#"{"op":"quota"}"#)).await;
    set_status(b, |s| {
        s.connected = true;
        s.last_error = None;
    });
    let mut sessions: HashMap<String, Sess> = HashMap::new();
    let mut seen = Seen::default();
    // Replies from method handlers: (session id, plaintext JSON).
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<(String, String)>();
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    // The relay's count moves with traffic; ask again every five minutes for Settings.
    let mut quota = tokio::time::interval(Duration::from_mins(5));
    quota.tick().await;
    loop {
        let mut outgoing: Vec<String> = Vec::new();
        tokio::select! {
            msg = source.next() => match msg {
                Some(Ok(Message::Text(t))) => {
                    if on_relay_frame(b, t.as_str(), &current, &mut sessions, &mut seen, &out_tx, &mut outgoing) {
                        // The relay will not move this connection to another account: start over.
                        return true;
                    }
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                _ => break,
            },
            reply = out_rx.recv() => {
                if let Some((sid, plain)) = reply
                    && let Some(s) = sessions.get_mut(&sid)
                    && let Some(f) = s.channel.seal_text(&plain)
                {
                    outgoing.push(json!({ "op": "send", "to": s.device_route, "body": f }).to_string());
                }
            }
            cmd = cmds.recv() => match cmd {
                Some(Cmd::Pairings) => {
                    let next = routes(b);
                    for host in current.by_route.keys().filter(|h| !next.by_route.contains_key(*h)) {
                        outgoing.push(json!({ "op": "unsub", "route": host }).to_string());
                    }
                    for host in next.by_route.keys().filter(|h| !current.by_route.contains_key(*h)) {
                        outgoing.push(json!({ "op": "sub", "route": host }).to_string());
                    }
                    sessions.retain(|_, s| next.by_pairing.contains_key(&s.pairing_id));
                    current = next;
                }
                Some(Cmd::Quota) => outgoing.push(r#"{"op":"quota"}"#.to_owned()),
                Some(Cmd::Token) => match auth_frame(b) {
                    // A refreshed session for the same account is accepted on this connection.
                    Some(auth) => outgoing.push(auth),
                    // A relay connection cannot sign out: reconnect without an account.
                    None => return true,
                },
                None => break,
            },
            _ = quota.tick() => outgoing.push(r#"{"op":"quota"}"#.to_owned()),
            _ = ping.tick() => {
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
        }
        set_status(b, |s| s.sessions = sessions.len());
        for o in outgoing {
            if sink.send(Message::text(o)).await.is_err() {
                return started.elapsed() > Duration::from_secs(30);
            }
        }
    }
    started.elapsed() > Duration::from_secs(30)
}

fn random<const N: usize>() -> Option<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).ok()?;
    Some(b)
}

/// Session ids seen in the last hour, by pairing: a replayed init is refused.
#[derive(Default)]
struct Seen(HashMap<(String, String), u64>);

impl Seen {
    /// Records `sid` for `pairing`; false when it was seen within the hour.
    fn first(&mut self, pairing: &str, sid: &str, now: u64) -> bool {
        self.0.retain(|_, at| now.saturating_sub(*at) < SEEN_SESSIONS_MS);
        if self.0.len() >= MAX_SEEN_SESSIONS
            && let Some(oldest) = self.0.iter().min_by_key(|(_, at)| **at).map(|(k, _)| k.clone())
        {
            self.0.remove(&oldest);
        }
        self.0.insert((pairing.to_owned(), sid.to_owned()), now).is_none()
    }
}

/// Makes room for a session that just proved itself: the oldest proven sessions of its pairing go
/// past `SESSIONS_PER_PAIRING`.
fn admit(sessions: &mut HashMap<String, Sess>, pairing_id: &str, sid: &str) {
    let mut mine: Vec<(u64, String)> = sessions
        .iter()
        .filter(|(k, s)| s.pairing_id == pairing_id && s.proven && k.as_str() != sid)
        .map(|(k, s)| (s.opened, k.clone()))
        .collect();
    mine.sort();
    while mine.len() >= SESSIONS_PER_PAIRING {
        let (_, old) = mine.remove(0);
        sessions.remove(&old);
    }
}

/// The relay's own messages (quota, sign-in, errors). True when the relay says another account holds
/// this hub, so the connection should drop to the anonymous tier.
fn on_relay_control(b: &Arc<Bridge>, op: &str, msg: Value, outgoing: &mut Vec<String>) -> bool {
    match op {
        "quota" => {
            set_status(b, |s| s.quota = Some(msg.clone()));
            // Settings shows it live: `remote.quota` events carry the relay's numbers.
            b.hub.emit("remote.quota", msg);
            false
        }
        "auth" => {
            set_status(b, |s| {
                s.signed_in = msg.get("ok").and_then(Value::as_bool) == Some(true);
                s.last_error = None;
            });
            outgoing.push(r#"{"op":"quota"}"#.to_owned());
            false
        }
        "error" => {
            let code = msg
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("error")
                .to_owned();
            let scope = msg.get("scope").and_then(Value::as_str).map(str::to_owned);
            let message = msg.get("message").and_then(Value::as_str).unwrap_or_default();
            // A refused account session leaves the connection on the anonymous tier.
            let session = message.contains("session") || message.contains("another account");
            set_status(b, |s| {
                if session {
                    s.signed_in = false;
                    s.last_error =
                        Some("the relay refused the account session; using the anonymous tier".to_owned());
                } else {
                    s.last_error = Some(scope.map_or(code.clone(), |sc| format!("{code} ({sc})")));
                }
            });
            message.contains("another account")
        }
        _ => false,
    }
}

fn on_relay_frame(
    b: &Arc<Bridge>,
    text: &str,
    routes: &Routes,
    sessions: &mut HashMap<String, Sess>,
    seen: &mut Seen,
    out: &mpsc::UnboundedSender<(String, String)>,
    outgoing: &mut Vec<String>,
) -> bool {
    let Ok(msg) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    match msg.get("op").and_then(Value::as_str) {
        Some("msg") => {}
        Some(op) => return on_relay_control(b, op, msg.clone(), outgoing),
        None => return false,
    }
    let (Some(route), Some(body)) = (
        msg.get("route").and_then(Value::as_str),
        msg.get("body").and_then(Value::as_str),
    ) else {
        return false;
    };
    let Some(pairing_id) = routes.by_route.get(route) else {
        return false;
    };
    match ps::parse_frame(body) {
        Some(SessionFrame::Init(init)) => {
            on_init(b, &init, route, pairing_id, routes, sessions, seen, out, outgoing);
        }
        Some(SessionFrame::Data(f)) => {
            let Some(s) = sessions.get_mut(&f.s) else {
                return false;
            };
            if &s.pairing_id != pairing_id {
                return false;
            }
            let Some(plain) = s.channel.open(&f) else {
                return false;
            };
            if !s.proven {
                // The device holds the session keys: it is live, and only now may it push out the
                // pairing's oldest session.
                s.proven = true;
                let pid = s.pairing_id.clone();
                admit(sessions, &pid, &f.s);
            }
            let Some(s) = sessions.get_mut(&f.s) else {
                return false;
            };
            let Ok(envelope) = serde_json::from_slice::<Value>(&plain) else {
                return false;
            };
            if envelope.get("t").and_then(Value::as_str) != Some("req") {
                return false;
            }
            let Some(id) = envelope.get("id").and_then(Value::as_u64) else {
                return false;
            };
            let method = envelope
                .get("m")
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .take(40)
                .collect::<String>();
            let params = envelope.get("p").cloned().unwrap_or(Value::Null);
            let (b, out, sid, ctx) = (b.clone(), out.clone(), f.s.clone(), s.ctx.clone());
            // A few requests at a time per session; past that the device hears `busy` at once.
            if ctx.inflight.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= crate::remote_rpc::IN_FLIGHT
            {
                ctx.inflight.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                let busy = json!({ "t": "res", "id": id, "ok": false, "e": { "code": "busy", "message": "too many requests at once; try again shortly" } });
                let _ = out.send((sid, busy.to_string()));
                return false;
            }
            tokio::spawn(async move {
                let reply = match crate::remote_rpc::handle(&b, &ctx, &method, params).await {
                    Ok(r) => json!({ "t": "res", "id": id, "ok": true, "r": r }),
                    Err((code, message)) => {
                        json!({ "t": "res", "id": id, "ok": false, "e": { "code": code, "message": message } })
                    }
                };
                ctx.inflight.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                let _ = out.send((sid, reply.to_string()));
            });
        }
        _ => {}
    }
    false
}

/// An init on a pairing's host route: answers it when the device key checks out and the session id
/// is new, and keeps the session unproven until the device sends authenticated data.
#[allow(clippy::too_many_arguments)]
fn on_init(
    b: &Arc<Bridge>,
    init: &ps::InitFrame,
    route: &str,
    pairing_id: &str,
    routes: &Routes,
    sessions: &mut HashMap<String, Sess>,
    seen: &mut Seen,
    out: &mpsc::UnboundedSender<(String, String)>,
    outgoing: &mut Vec<String>,
) {
    if init.r != route || sessions.contains_key(&init.s) {
        return;
    }
    let Some(key) = lock(&b.remote.keys).get(pairing_id).copied() else {
        return;
    };
    if !ps::verify_init(init, &key) {
        return;
    }
    // An init seen before is a replay (the relay sees every one): no answer.
    if !seen.first(pairing_id, &init.s, crate::hub::now_ms()) {
        return;
    }
    let Some((_, device_route)) = routes.by_pairing.get(pairing_id) else {
        return;
    };
    // An older phone hears that it needs an update; it never gets the old key schedule.
    if !ps::init_current(init) {
        let refuse = json!({ "k": "refuse", "s": init.s, "reason": "update" }).to_string();
        outgoing.push(json!({ "op": "send", "to": device_route, "body": refuse }).to_string());
        return;
    }
    let Some(host_dh) = *lock(&b.remote.host_dh) else {
        return;
    };
    let (Some(eph), Some(nonce)) = (random::<32>(), random::<16>()) else {
        return;
    };
    let Some((accept, channel)) = ps::accept(&eph, &nonce, init, &key, &host_dh) else {
        return;
    };
    // A session that has not yet sent authenticated data pushes out no live one: only the
    // oldest unproven sessions of the same pairing past the per-pairing count, then, when the
    // hub is full, the oldest unproven, then the oldest.
    let mut unproven: Vec<(u64, String)> = sessions
        .iter()
        .filter(|(_, s)| s.pairing_id == pairing_id && !s.proven)
        .map(|(k, s)| (s.opened, k.clone()))
        .collect();
    unproven.sort();
    while unproven.len() >= SESSIONS_PER_PAIRING {
        let (_, sid) = unproven.remove(0);
        sessions.remove(&sid);
    }
    if sessions.len() >= MAX_SESSIONS {
        let oldest = sessions
            .iter()
            .min_by_key(|(_, s)| (s.proven, s.opened))
            .map(|(k, _)| k.clone());
        if let Some(oldest) = oldest {
            sessions.remove(&oldest);
        }
    }
    let Ok(body) = serde_json::to_string(&accept) else {
        return;
    };
    outgoing.push(json!({ "op": "send", "to": device_route, "body": body }).to_string());
    let Some(pairing) = b.remote.pairing(pairing_id) else {
        return;
    };
    let ctx = crate::remote_rpc::SessCtx::new(b, init.s.clone(), &pairing, out.clone());
    sessions.insert(
        init.s.clone(),
        Sess {
            pairing_id: pairing_id.to_owned(),
            channel,
            device_route: device_route.clone(),
            opened: crate::hub::now_ms(),
            proven: false,
            ctx,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(claims: &Value) -> String {
        use base64::Engine as _;
        let e = |b: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b);
        format!(
            "{}.{}.{}",
            e(br#"{"alg":"ES256"}"#),
            e(claims.to_string().as_bytes()),
            e(b"sig")
        )
    }

    #[test]
    fn m4_the_hub_carries_only_relay_tokens_never_the_account_session() {
        assert!(valid_token(&jwt(
            &json!({ "aud": "sx-relay", "sub": "a", "exp": 1 })
        )));
        assert!(valid_token(&jwt(
            &json!({ "aud": ["sx-relay"], "sub": "a", "exp": 1 })
        )));
        // The Supabase session's own audience, or a token good for the relay and something else.
        assert!(!valid_token(&jwt(
            &json!({ "aud": "authenticated", "sub": "a", "exp": 1 })
        )));
        assert!(!valid_token(&jwt(
            &json!({ "aud": ["sx-relay", "authenticated"], "sub": "a", "exp": 1 })
        )));
        assert!(!valid_token(&jwt(&json!({ "sub": "a", "exp": 1 }))));
        assert!(!valid_token("not.a token.at all"));
    }

    #[test]
    fn l1_an_init_is_answered_once_an_hour() {
        let mut seen = Seen::default();
        assert!(seen.first("p", "s1", 1_000));
        assert!(!seen.first("p", "s1", 2_000));
        assert!(seen.first("q", "s1", 2_000));
        assert!(seen.first("p", "s1", 2_000 + SEEN_SESSIONS_MS));
    }

    #[test]
    fn relay_urls_are_tls_or_this_machine() {
        assert!(valid_relay_url("wss://relay.slicerx.app/v1"));
        assert!(valid_relay_url("ws://127.0.0.1:8787/v1"));
        assert!(!valid_relay_url("ws://relay.slicerx.app/v1"));
        assert!(!valid_relay_url("ws://127.0.0.1.evil.example/v1"));
        assert_eq!(
            host_port("wss://relay.slicerx.app/v1"),
            Some(("relay.slicerx.app".to_owned(), 443))
        );
        assert_eq!(
            host_port("ws://127.0.0.1:8787/v1"),
            Some(("127.0.0.1".to_owned(), 8787))
        );
    }
}
