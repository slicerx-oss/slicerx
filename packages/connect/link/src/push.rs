// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Phone alerts while the app is closed. A paired phone registers its Expo push token through the
//! app (`push.register`); when the watcher sees a print finish, fail or stop, or the hub raises an
//! approval card, the hub posts one push per registered phone to Expo's push service.
//!
//! The text a push shows travels through Expo and Apple or Google, so it is fixed and names no
//! file, model or printer. `data` carries the alert kind and the printer id for routing a tap; the
//! phone loads everything else over the paired channel when it opens.
//!
//! Partner phones (another company's app, paired under its own name) register their own token through
//! their pairing (`push.registerPartner`, over the relay or the app). They get the same fixed text, sent
//! through their own push project, and the hub never holds a partner's APNs or FCM key:
//! - `expo`: one post per phone to Expo's push service, with no access token. Expo delivers through the
//!   partner's own Expo project, which holds the partner's credentials. Our own access token is never sent
//!   with a partner's token, and partner tokens never share a post with ours.
//! - `apns` or `fcm`: the hub posts the same fixed text to the partner's push gateway (an https address the
//!   phone names), which delivers with the partner's own key. The address must resolve to public addresses
//!   only and is not followed through redirects, so a phone cannot aim the hub at the person's network.
//!
//! Partner data carries the alert kind only (no printer id, no request id), and each partner phone gets
//! at most `PARTNER_PUSHES_PER_HOUR` in any hour. A token registered to one phone is never taken over by
//! another. A partner phone gets approval alerts only while it may approve, checked when each is sent.
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::hub::{lock, now_ms};
use crate::rpc::{Bridge, Rpc, RpcError, str_arg};

/// Expo's push endpoint.
pub const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";
/// Keychain entry for an Expo access token, needed only when the project turned on push security.
pub const ACCESS_TOKEN_SECRET: &str = "sx-link-expo-access-token";
/// Registrations kept at once; the oldest goes first.
const MAX_REGS: usize = 32;
/// Partner registrations kept at once (one per partner phone), inside `MAX_REGS`.
const MAX_PARTNER_REGS: usize = 16;
/// Pushes one partner phone gets in an hour; more are dropped until the hour turns.
pub(crate) const PARTNER_PUSHES_PER_HOUR: u32 = 30;
const HOUR_MS: u64 = 60 * 60 * 1000;

/// Who delivers a registration's pushes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Provider {
    /// Expo's push service: our own project for our phone, the partner's own project for a partner token.
    #[default]
    Expo,
    /// A partner's APNs token, delivered by the partner's gateway.
    Apns,
    /// A partner's FCM token, delivered by the partner's gateway.
    Fcm,
}

impl Provider {
    fn as_str(self) -> &'static str {
        match self {
            Provider::Expo => "expo",
            Provider::Apns => "apns",
            Provider::Fcm => "fcm",
        }
    }
}

#[allow(clippy::trivially_copy_pass_by_ref)] // serde's skip_serializing_if passes a reference.
fn is_expo(p: &Provider) -> bool {
    *p == Provider::Expo
}

/// Which alerts a phone wants. Same names as the phone's notification settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)] // One switch per alert kind, as the phone stores them.
pub(crate) struct PushPrefs {
    #[serde(default)]
    pub print_done: bool,
    #[serde(default)]
    pub print_failed: bool,
    #[serde(default)]
    pub attention: bool,
    #[serde(default)]
    pub approvals: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PushReg {
    pub token: String,
    /// `ios` or `android`.
    pub platform: String,
    pub prefs: PushPrefs,
    /// Opaque tag from the app (its pairing id), so revoking a pairing removes its phone's token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    pub created_at_ms: u64,
    #[serde(default, skip_serializing_if = "is_expo")]
    pub provider: Provider,
    /// The partner app name, for a partner phone's own token. Its tag is its pairing id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partner: Option<String>,
    /// The partner's push gateway, for `apns` and `fcm`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway: Option<String>,
    /// A partner phone's approve right as the app last said (`push.partnerApprovals`). Approval alerts
    /// go only while it is true, and only while a remote pairing of the phone says so too.
    #[serde(default = "yes", skip_serializing_if = "is_true")]
    pub may_approve: bool,
}

const fn yes() -> bool {
    true
}

#[allow(clippy::trivially_copy_pass_by_ref)] // serde's skip_serializing_if passes a reference.
const fn is_true(v: &bool) -> bool {
    *v
}

/// An APNs device token (hex) or an FCM registration token.
fn valid_device_token(provider: Provider, t: &str) -> bool {
    match provider {
        Provider::Expo => valid_token(t),
        Provider::Apns => (64..=200).contains(&t.len()) && t.bytes().all(|c| c.is_ascii_hexdigit()),
        Provider::Fcm => {
            (32..=512).contains(&t.len())
                && t.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b':' | b'.' | b'-'))
        }
    }
}

/// A partner gateway address: https on a DNS name, no user info, query or fragment, 200 characters at
/// most. `local_ok` (tests only) also takes plain http to this machine.
pub(crate) fn valid_gateway(url: &str, local_ok: bool) -> bool {
    if url.len() > 200 {
        return false;
    }
    let Ok(u) = reqwest::Url::parse(url) else {
        return false;
    };
    let host = u
        .host_str()
        .unwrap_or_default()
        .trim_start_matches('[')
        .trim_end_matches(']');
    let host_ok = match host.parse::<IpAddr>() {
        Ok(ip) => local_ok && ip.is_loopback(),
        Err(_) => host.contains('.') && !crate::net::is_lan_host(host),
    };
    let scheme_ok = u.scheme() == "https" || (local_ok && u.scheme() == "http");
    host_ok
        && scheme_ok
        && u.username().is_empty()
        && u.password().is_none()
        && u.query().is_none()
        && u.fragment().is_none()
}

/// Whether an address is on the public internet: not loopback, private, link-local, shared, documentation,
/// multicast or unspecified.
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_broadcast()
                || v.is_documentation()
                || v.is_unspecified()
                || v.is_multicast()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64)
                || (o[0] == 198 && (o[1] & 0xfe) == 18)
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)
                || o[0] >= 240)
        }
        IpAddr::V6(v) => {
            if let Some(m) = v.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(m));
            }
            let [s0, s1, s2, s3, s4, s5, _, _] = v.segments();
            // 6to4 (2002::/16) carries an IPv4 address in its next 32 bits: judge that one.
            if s0 == 0x2002 {
                return public_ip(IpAddr::V4(std::net::Ipv4Addr::from(
                    (u32::from(s1) << 16) | u32::from(s2),
                )));
            }
            // NAT64 (64:ff9b::/96 and the local-use 64:ff9b:1::/48) reaches IPv4 hosts behind a gateway.
            let nat64 = s0 == 0x0064 && s1 == 0xff9b && ((s2, s3, s4, s5) == (0, 0, 0, 0) || s2 == 1);
            // IPv4-compatible ::a.b.c.d (deprecated, never a real host).
            let compatible = (s0, s1, s2, s3, s4, s5) == (0, 0, 0, 0, 0, 0);
            !(v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || nat64
                || compatible
                || (s0 & 0xfe00) == 0xfc00
                || (s0 & 0xffc0) == 0xfe80
                || (s0 & 0xffc0) == 0xfec0
                || s0 == 0x2001 && s1 == 0x0db8)
        }
    }
}

/// What a push is about. Wire names match the phone's `PushKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PushKind {
    PrintDone,
    PrintFailed,
    Attention,
    Approval,
}

impl PushKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            PushKind::PrintDone => "print_done",
            PushKind::PrintFailed => "print_failed",
            PushKind::Attention => "attention",
            PushKind::Approval => "approval",
        }
    }

    /// The hub's alert kinds (`finished`, `failed`, `canceled`, `paused`, `error`, `approval_waiting`).
    pub(crate) fn for_alert(alert: &str) -> Option<Self> {
        match alert {
            "finished" => Some(PushKind::PrintDone),
            "failed" | "canceled" => Some(PushKind::PrintFailed),
            "paused" | "error" | "watch" => Some(PushKind::Attention),
            "approval_waiting" => Some(PushKind::Approval),
            _ => None,
        }
    }

    /// Title and body. Fixed text: nothing that names a file, a model or a printer.
    pub(crate) fn text(self) -> (&'static str, String) {
        let app = crate::app_name();
        match self {
            PushKind::PrintDone => (
                "Print finished",
                format!("A printer is done. Open {app} to see which."),
            ),
            PushKind::PrintFailed => (
                "Print stopped",
                format!("A print did not finish. Open {app} for details."),
            ),
            PushKind::Attention => (
                "A printer needs you",
                format!("Open {app} to see what it is waiting for."),
            ),
            PushKind::Approval => (
                "Approval waiting",
                format!("Something is waiting for your answer in {app}."),
            ),
        }
    }

    fn wanted(self, p: PushPrefs) -> bool {
        match self {
            PushKind::PrintDone => p.print_done,
            PushKind::PrintFailed => p.print_failed,
            PushKind::Attention => p.attention,
            PushKind::Approval => p.approvals,
        }
    }
}

/// `ExponentPushToken[...]` or `ExpoPushToken[...]`.
pub(crate) fn valid_token(t: &str) -> bool {
    let inner = t
        .strip_prefix("ExponentPushToken[")
        .or_else(|| t.strip_prefix("ExpoPushToken["))
        .and_then(|r| r.strip_suffix(']'));
    inner.is_some_and(|i| {
        (10..=200).contains(&i.len())
            && i.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    })
}

/// The registrations and the HTTP client that posts to Expo.
pub(crate) struct Pusher {
    url: String,
    client: Option<reqwest::Client>,
    regs: Arc<StdMutex<Vec<PushReg>>>,
    changed: Arc<AtomicBool>,
    /// Pushes sent to each partner phone this hour, by tag: (hour, count).
    sent: StdMutex<HashMap<String, VecDeque<u64>>>,
    /// Tests only: Expo is a local fake, so partner gateways on this machine are allowed too.
    local_ok: bool,
}

impl Pusher {
    /// `url` empty turns sending off (registrations are still kept).
    pub(crate) fn new(url: &str, regs: Vec<PushReg>) -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = if url.is_empty() {
            None
        } else {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(20))
                .build()
                .ok()
        };
        Self {
            url: url.to_owned(),
            client,
            regs: Arc::new(StdMutex::new(regs)),
            changed: Arc::new(AtomicBool::new(false)),
            sent: StdMutex::new(HashMap::new()),
            // Only a test points Expo at this machine; a real hub posts to exp.host.
            local_ok: url.starts_with("http://127.0.0.1:"),
        }
    }

    /// Whether the hub sends pushes at all (a push URL was set).
    pub(crate) fn sending(&self) -> bool {
        self.client.is_some()
    }

    pub(crate) fn regs(&self) -> Vec<PushReg> {
        lock(&self.regs).clone()
    }

    /// True once after the registrations changed (a phone was removed after Expo refused it).
    pub(crate) fn take_changed(&self) -> bool {
        self.changed.swap(false, Ordering::Relaxed)
    }

    /// Keeps a registration. A token another phone (another tag) holds is refused, never taken over,
    /// with one exception: our own phone's registration (through the app) replaces a partner's of the
    /// same token, so a partner that learned it cannot hold our phone's alerts. That partner hears
    /// `conflict` when it registers again. Between partner phones, and between our phones, the first
    /// keeps it.
    fn register(&self, reg: PushReg) -> Result<(), RpcError> {
        let mut r = lock(&self.regs);
        if reg.partner.is_none() {
            r.retain(|x| !(x.token == reg.token && x.partner.is_some()));
        }
        if r.iter().any(|x| x.token == reg.token && x.tag != reg.tag) {
            return Err(RpcError::new(
                "conflict",
                "this push token is registered to another phone",
            ));
        }
        r.retain(|x| x.token != reg.token);
        // A partner phone holds one registration: its new token replaces the old one.
        if reg.partner.is_some() {
            r.retain(|x| x.partner.is_none() || x.tag != reg.tag);
            while r.iter().filter(|x| x.partner.is_some()).count() >= MAX_PARTNER_REGS {
                let Some(i) = r.iter().position(|x| x.partner.is_some()) else {
                    break;
                };
                r.remove(i);
            }
        }
        r.push(reg);
        while r.len() > MAX_REGS {
            r.remove(0);
        }
        Ok(())
    }

    /// Whether a partner phone (by tag) may approve now, as the app or its hub pairing says. Returns how
    /// many registrations changed.
    fn set_may_approve(&self, tag: &str, may: bool) -> usize {
        let mut n = 0;
        for x in lock(&self.regs)
            .iter_mut()
            .filter(|x| x.partner.is_some() && x.tag.as_deref() == Some(tag) && x.may_approve != may)
        {
            x.may_approve = may;
            n += 1;
        }
        n
    }

    /// Counts one push to a partner phone; false once it had `PARTNER_PUSHES_PER_HOUR` in the last hour.
    fn partner_allowance(&self, tag: &str, now: u64) -> bool {
        let mut sent = lock(&self.sent);
        sent.retain(|_, q| q.back().is_some_and(|t| now.saturating_sub(*t) < HOUR_MS));
        let q = sent.entry(tag.to_owned()).or_default();
        while q.front().is_some_and(|t| now.saturating_sub(*t) >= HOUR_MS) {
            q.pop_front();
        }
        if q.len() >= PARTNER_PUSHES_PER_HOUR as usize {
            return false;
        }
        q.push_back(now);
        true
    }

    /// Pushes a partner phone had in the last hour.
    fn partner_sent(&self, tag: &str, now: u64) -> u32 {
        lock(&self.sent).get(tag).map_or(0, |q| {
            u32::try_from(q.iter().filter(|t| now.saturating_sub(**t) < HOUR_MS).count()).unwrap_or(u32::MAX)
        })
    }

    fn unregister(&self, token: Option<&str>, tag: Option<&str>) -> usize {
        let mut r = lock(&self.regs);
        let before = r.len();
        r.retain(|x| token.is_none_or(|t| x.token != t) && tag.is_none_or(|t| x.tag.as_deref() != Some(t)));
        before - r.len()
    }

    /// Sends `kind` to every phone that wants it. Returns at once; the posts run in the background.
    /// `no_approvals` names partner phones (by tag) that may not approve, so they get no approval alert.
    pub(crate) fn notify(
        &self,
        kind: PushKind,
        printer_id: Option<&str>,
        request_id: Option<&str>,
        access_token: Option<String>,
        no_approvals: &HashSet<String>,
    ) {
        if self.client.is_none() {
            return;
        }
        self.notify_partners(kind, no_approvals);
        self.notify_own(kind, printer_id, request_id, access_token);
    }

    /// Our own phones: one post to our Expo project, with our access token when there is one.
    fn notify_own(
        &self,
        kind: PushKind,
        printer_id: Option<&str>,
        request_id: Option<&str>,
        access_token: Option<String>,
    ) {
        let Some(client) = self.client.clone() else { return };
        let tokens: Vec<String> = lock(&self.regs)
            .iter()
            .filter(|r| r.partner.is_none() && kind.wanted(r.prefs))
            .map(|r| r.token.clone())
            .collect();
        if tokens.is_empty() {
            return;
        }
        let (title, body) = kind.text();
        let mut data = serde_json::Map::new();
        data.insert("kind".into(), json!(kind.as_str()));
        if let Some(p) = printer_id {
            data.insert("printerId".into(), json!(p));
        }
        if let Some(r) = request_id {
            data.insert("requestId".into(), json!(r));
        }
        let messages: Vec<Value> = tokens
            .iter()
            .map(|t| {
                json!({ "to": t, "title": title, "body": body, "data": data, "sound": "default", "priority": "high" })
            })
            .collect();
        let url = self.url.clone();
        let regs = self.regs.clone();
        let changed = self.changed.clone();
        tokio::spawn(async move {
            let mut rb = client
                .post(&url)
                .header("accept", "application/json")
                .json(&messages);
            if let Some(t) = access_token {
                rb = rb.bearer_auth(t);
            }
            let reply: Value = match rb.send().await {
                Ok(r) if r.status().is_success() => r.json().await.unwrap_or(Value::Null),
                Ok(r) => {
                    eprintln!("sx-link: the push service answered HTTP {}", r.status().as_u16());
                    return;
                }
                Err(e) => {
                    eprintln!("sx-link: cannot reach the push service: {}", e.without_url());
                    return;
                }
            };
            // Tickets come back in the order sent. A phone that uninstalled the app is dropped.
            let gone: Vec<&String> = reply
                .get("data")
                .and_then(Value::as_array)
                .map(|tickets| {
                    tickets
                        .iter()
                        .zip(&tokens)
                        .filter(|(t, _)| {
                            t.pointer("/details/error").and_then(Value::as_str) == Some("DeviceNotRegistered")
                        })
                        .map(|(_, tok)| tok)
                        .collect()
                })
                .unwrap_or_default();
            if !gone.is_empty() {
                lock(&regs).retain(|r| !gone.contains(&&r.token));
                changed.store(true, Ordering::Relaxed);
            }
        });
    }

    /// Partner phones: one post each, through the partner's own project or gateway, never with our token.
    fn notify_partners(&self, kind: PushKind, no_approvals: &HashSet<String>) {
        let Some(client) = self.client.clone() else { return };
        let now = now_ms();
        let targets: Vec<PushReg> = lock(&self.regs)
            .iter()
            .filter(|r| r.partner.is_some() && kind.wanted(r.prefs))
            .filter(|r| {
                kind != PushKind::Approval
                    || (r.may_approve && r.tag.as_ref().is_none_or(|t| !no_approvals.contains(t)))
            })
            .cloned()
            .collect();
        let (title, body) = kind.text();
        for reg in targets {
            let tag = reg.tag.clone().unwrap_or_default();
            if !self.partner_allowance(&tag, now) {
                continue;
            }
            // The kind only: no printer or card id, since a partner's servers read it. The phone loads
            // the rest over its sealed connection.
            let mut data = serde_json::Map::new();
            data.insert("kind".into(), json!(kind.as_str()));
            let (client, url, regs, changed, local_ok) = (
                client.clone(),
                self.url.clone(),
                self.regs.clone(),
                self.changed.clone(),
                self.local_ok,
            );
            let body = body.clone();
            tokio::spawn(async move {
                let gone = match reg.provider {
                    Provider::Expo => {
                        let msg = json!([{ "to": reg.token, "title": title, "body": body, "data": data, "sound": "default", "priority": "high" }]);
                        post_expo(&client, &url, &msg).await
                    }
                    Provider::Apns | Provider::Fcm => {
                        let msg = json!({
                            "provider": reg.provider.as_str(), "platform": reg.platform, "token": reg.token,
                            "title": title, "body": body, "data": data,
                        });
                        post_gateway(reg.gateway.as_deref().unwrap_or_default(), &msg, local_ok).await
                    }
                };
                if gone {
                    lock(&regs).retain(|r| r.token != reg.token);
                    changed.store(true, Ordering::Relaxed);
                }
            });
        }
    }
}

/// Posts one partner message to Expo, without any access token. True when Expo says the phone is gone.
async fn post_expo(client: &reqwest::Client, url: &str, msg: &Value) -> bool {
    match client
        .post(url)
        .header("accept", "application/json")
        .json(msg)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            let reply: Value = r.json().await.unwrap_or(Value::Null);
            reply.pointer("/data/0/details/error").and_then(Value::as_str) == Some("DeviceNotRegistered")
        }
        Ok(r) => {
            eprintln!(
                "sx-link: the push service answered HTTP {} for a partner phone",
                r.status().as_u16()
            );
            false
        }
        Err(e) => {
            eprintln!("sx-link: cannot reach the push service: {}", e.without_url());
            false
        }
    }
}

/// Posts one message to a partner's gateway. The name is resolved here and must give public addresses
/// only; the connection is pinned to them and redirects are not followed. True on HTTP 410 (the phone is gone).
async fn post_gateway(url: &str, msg: &Value, local_ok: bool) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else {
        return false;
    };
    let (Some(host), Some(port)) = (u.host_str().map(str::to_owned), u.port_or_known_default()) else {
        return false;
    };
    let Ok(found) = tokio::net::lookup_host((host.as_str(), port)).await else {
        eprintln!("sx-link: a partner push gateway did not resolve");
        return false;
    };
    let addrs: Vec<SocketAddr> = found.collect();
    let allowed = |a: &SocketAddr| public_ip(a.ip()) || (local_ok && a.ip().is_loopback());
    if addrs.is_empty() || !addrs.iter().all(allowed) {
        eprintln!("sx-link: a partner push gateway resolves to a local address; not sent");
        return false;
    }
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        // Straight to the pinned addresses: a system proxy would resolve the name again on its own.
        .no_proxy()
        .resolve_to_addrs(&host, &addrs)
        .build()
    else {
        return false;
    };
    match client
        .post(u)
        .header("accept", "application/json")
        .json(msg)
        .send()
        .await
    {
        Ok(r) if r.status().as_u16() == 410 => true,
        Ok(r) if r.status().is_success() => false,
        Ok(r) => {
            eprintln!(
                "sx-link: a partner push gateway answered HTTP {}",
                r.status().as_u16()
            );
            false
        }
        Err(e) => {
            eprintln!(
                "sx-link: cannot reach a partner push gateway: {}",
                e.without_url()
            );
            false
        }
    }
}

/// Sends a push for one hub alert, if the alert kind calls for one.
///
/// A card waiting for an answer is pushed only when a phone can show it (`remote_rpc::phone_can_show`):
/// a card answered in the app alone, such as a connected app's call, would open to nothing.
pub(crate) fn alert(b: &Bridge, alert: &str, printer_id: Option<&str>, request_id: Option<&str>) {
    if alert == "approval_waiting" && request_id.is_some_and(|id| !crate::remote_rpc::phone_can_show(b, id)) {
        return;
    }
    if let Some(kind) = PushKind::for_alert(alert) {
        let token = sx_connect::Secrets::get(b.secrets_ref(), ACCESS_TOKEN_SECRET);
        // Partner phones the hub knows from remote access follow their pairing's approve right as it is now.
        let mut no_approvals: HashSet<String> = b
            .remote
            .partner_pairings()
            .into_iter()
            .filter(|p| !p.rights.approve)
            .map(|p| p.pairing_id)
            .collect();
        // No partner phone approves a card a partner app raised, or one whose raiser the hub has no record
        // of, so none of them is asked to.
        if kind == PushKind::Approval
            && !request_id
                .is_some_and(|id| crate::remote_rpc::phone_may_approve(true, lock(&b.card_raisers).get(id)))
        {
            no_approvals.extend(
                b.hub
                    .push
                    .regs()
                    .into_iter()
                    .filter(|r| r.partner.is_some())
                    .filter_map(|r| r.tag),
            );
        }
        b.hub
            .push
            .notify(kind, printer_id, request_id, token, &no_approvals);
    }
}

/// A partner registration from its params: the provider, token, platform, prefs and gateway. `approvals`
/// is whether the phone may approve now; without it the phone gets no approval alerts.
fn partner_reg(pusher: &Pusher, p: &Value, tag: String, partner: String, approvals: bool) -> Rpc<PushReg> {
    let provider: Provider = p
        .get("provider")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| RpcError::new("bad_request", "provider is expo, apns or fcm"))?
        .ok_or_else(|| RpcError::new("bad_request", "provider is required"))?;
    let token = str_arg(p, "token")?;
    if !valid_device_token(provider, &token) {
        return Err(RpcError::new(
            "bad_request",
            format!("token is not a {} token", provider.as_str()),
        ));
    }
    let platform = str_arg(p, "platform")?;
    if !matches!(platform.as_str(), "ios" | "android") {
        return Err(RpcError::new("bad_request", "platform is ios or android"));
    }
    let prefs: PushPrefs = serde_json::from_value(p.get("prefs").cloned().unwrap_or(Value::Null))
        .map_err(|_| RpcError::new("bad_request", "prefs is malformed"))?;
    let gateway = p.get("gateway").and_then(Value::as_str).map(str::to_owned);
    match (provider, &gateway) {
        (Provider::Expo, Some(_)) => {
            return Err(RpcError::new(
                "bad_request",
                "expo tokens go to Expo; leave out gateway",
            ));
        }
        (Provider::Apns | Provider::Fcm, None) => {
            return Err(RpcError::new(
                "bad_request",
                "apns and fcm tokens need the partner's push gateway",
            ));
        }
        (_, Some(g)) if !valid_gateway(g, pusher.local_ok) => {
            return Err(RpcError::new(
                "bad_request",
                "gateway must be an https address on a public name",
            ));
        }
        _ => {}
    }
    Ok(PushReg {
        token,
        platform,
        prefs,
        tag: Some(tag),
        created_at_ms: now_ms(),
        provider,
        partner: Some(partner),
        gateway,
        may_approve: approvals,
    })
}

/// `push.registerPartner` and `push.unregisterPartner` from a partner phone over the relay: only for its
/// own pairing, and only when that pairing is a partner phone's.
pub(crate) async fn remote_partner(
    b: &Arc<Bridge>,
    pairing: &crate::remote::RemotePairing,
    method: &str,
    p: &Value,
) -> Rpc<Value> {
    let Some(partner) = pairing
        .partner
        .clone()
        .filter(|_| pairing.kind == crate::remote::PeerKind::Phone)
    else {
        return Err(RpcError::new(
            "forbidden",
            "only a partner phone registers a partner push token",
        ));
    };
    if method == "push.registerPartner" {
        let reg = partner_reg(
            &b.hub.push,
            p,
            pairing.pairing_id.clone(),
            partner,
            pairing.rights.approve,
        )?;
        b.hub.push.register(reg)?;
        crate::hub_rpc::save(b).await;
    } else if b.hub.push.unregister(None, Some(&pairing.pairing_id)) > 0 {
        crate::hub_rpc::save(b).await;
    }
    Ok(json!({}))
}

/// A pairing's approve right as the hub now holds it (`remote.pairings.put`): its partner phone's push
/// token follows, both off and on. True when a registration changed.
pub(crate) fn follow_approve(b: &Bridge, pairing_id: &str, approve: bool) -> bool {
    b.hub.push.set_may_approve(pairing_id, approve) > 0
}

/// Drops the push registrations tagged with a pairing that was removed.
pub(crate) fn forget_pairing(b: &Bridge, pairing_id: &str) -> bool {
    b.hub.push.unregister(None, Some(pairing_id)) > 0
}

/// One registration as `push.list` and `push.status` show it: never the token, the gateway as its host only.
fn reg_view(r: &PushReg, pusher: &Pusher, now: u64) -> Value {
    let mut v = json!({
        "tokenEnd": tail(&r.token), "platform": r.platform, "prefs": r.prefs,
        "tag": r.tag, "createdAt": crate::hub::iso(r.created_at_ms), "provider": r.provider.as_str(),
    });
    if let (Some(partner), Some(o)) = (&r.partner, v.as_object_mut()) {
        let host = r
            .gateway
            .as_deref()
            .and_then(|g| reqwest::Url::parse(g).ok())
            .and_then(|u| u.host_str().map(str::to_owned));
        o.insert("partner".into(), json!(partner));
        o.insert("mayApprove".into(), json!(r.may_approve));
        o.insert("gatewayHost".into(), json!(host));
        o.insert(
            "sentThisHour".into(),
            json!(pusher.partner_sent(r.tag.as_deref().unwrap_or_default(), now)),
        );
    }
    v
}

fn tail(token: &str) -> String {
    let inner = token.trim_end_matches(']');
    inner
        .chars()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

/// `push.register`, `push.unregister`, `push.list`.
pub(crate) async fn call(b: &Arc<Bridge>, method: &str, p: &Value) -> Rpc<Value> {
    let tag = p
        .get("tag")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty() && t.len() <= 128)
        .map(str::to_owned);
    match method {
        "push.register" => {
            let token = str_arg(p, "token")?;
            if !valid_token(&token) {
                return Err(RpcError::new("bad_request", "token is not an Expo push token"));
            }
            let platform = str_arg(p, "platform")?;
            if !matches!(platform.as_str(), "ios" | "android") {
                return Err(RpcError::new("bad_request", "platform is ios or android"));
            }
            let prefs: PushPrefs = serde_json::from_value(p.get("prefs").cloned().unwrap_or(Value::Null))
                .map_err(|_| RpcError::new("bad_request", "prefs is malformed"))?;
            b.hub.push.register(PushReg {
                token,
                platform,
                prefs,
                tag,
                created_at_ms: now_ms(),
                provider: Provider::Expo,
                partner: None,
                gateway: None,
                may_approve: true,
            })?;
            crate::hub_rpc::save(b).await;
            Ok(json!({ "registered": true }))
        }
        "push.unregister" => {
            let token = p.get("token").and_then(Value::as_str);
            if token.is_none() && tag.is_none() {
                return Err(RpcError::new("bad_request", "token or tag is required"));
            }
            let n = b.hub.push.unregister(token, tag.as_deref());
            if n > 0 {
                crate::hub_rpc::save(b).await;
            }
            Ok(json!({ "unregistered": n }))
        }
        // The app hands over a partner phone's registration from its own pairing host (a partner phone on
        // the LAN). App only: the app checked the session is that partner's.
        "push.registerPartner" => {
            let tag = tag.ok_or_else(|| RpcError::new("bad_request", "tag (the pairing id) is required"))?;
            let partner = p
                .get("partner")
                .and_then(Value::as_str)
                .and_then(crate::remote::partner_name)
                .ok_or_else(|| RpcError::new("bad_request", "partner is the partner app name"))?;
            let approvals = p.get("approvals").and_then(Value::as_bool) == Some(true);
            let reg = partner_reg(&b.hub.push, p, tag, partner, approvals)?;
            b.hub.push.register(reg)?;
            crate::hub_rpc::save(b).await;
            Ok(json!({ "registered": true }))
        }
        // App only: a partner phone's approve right changed in Devices (LAN pairings the hub may not hold).
        "push.partnerApprovals" => {
            let tag = tag.ok_or_else(|| RpcError::new("bad_request", "tag (the pairing id) is required"))?;
            let may = p.get("approvals").and_then(Value::as_bool) == Some(true);
            if b.hub.push.set_may_approve(&tag, may) > 0 {
                crate::hub_rpc::save(b).await;
            }
            Ok(json!({ "updated": true }))
        }
        // Tokens are not echoed back; the last characters are enough to tell phones apart.
        "push.list" => {
            let now = now_ms();
            Ok(Value::Array(
                b.hub
                    .push
                    .regs()
                    .iter()
                    .map(|r| reg_view(r, &b.hub.push, now))
                    .collect(),
            ))
        }
        // What a client reads back (slicerx_push_status): whether the hub sends at all, each registration,
        // and the partner limits.
        "push.status" => {
            let now = now_ms();
            let regs = b.hub.push.regs();
            Ok(json!({
                "sending": b.hub.push.sending(),
                "registrations": regs.iter().map(|r| reg_view(r, &b.hub.push, now)).collect::<Vec<_>>(),
                "own": regs.iter().filter(|r| r.partner.is_none()).count(),
                "partners": regs.iter().filter(|r| r.partner.is_some()).count(),
                "limits": { "partnerPushesPerHour": PARTNER_PUSHES_PER_HOUR, "partnerRegistrations": MAX_PARTNER_REGS, "registrations": MAX_REGS },
            }))
        }
        other => Err(RpcError::new("bad_request", format!("unknown method {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_checked() {
        assert!(valid_token("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"));
        assert!(valid_token("ExpoPushToken[abcDEF0123-_x]"));
        assert!(!valid_token("ExponentPushToken[short]"));
        assert!(!valid_token("ExponentPushToken[has space here]"));
        assert!(!valid_token("https://evil.example/xxxxxxxxxxxx"));
    }

    #[test]
    fn alerts_map_to_push_kinds_with_content_free_text() {
        assert_eq!(PushKind::for_alert("finished"), Some(PushKind::PrintDone));
        assert_eq!(PushKind::for_alert("canceled"), Some(PushKind::PrintFailed));
        assert_eq!(PushKind::for_alert("error"), Some(PushKind::Attention));
        assert_eq!(PushKind::for_alert("approval_waiting"), Some(PushKind::Approval));
        assert_eq!(PushKind::for_alert("printing"), None);
        for k in [
            PushKind::PrintDone,
            PushKind::PrintFailed,
            PushKind::Attention,
            PushKind::Approval,
        ] {
            let (t, body) = k.text();
            assert!(!t.is_empty() && body.contains("SlicerX"));
        }
    }

    #[test]
    fn registrations_replace_by_token_and_cap() {
        let p = Pusher::new("", Vec::new());
        let prefs = PushPrefs {
            print_done: true,
            print_failed: true,
            attention: true,
            approvals: true,
        };
        for i in 0..40 {
            p.register(PushReg {
                token: format!("ExpoPushToken[token{i:08}]"),
                platform: "ios".into(),
                prefs,
                tag: Some(format!("p{}", i % 2)),
                created_at_ms: 0,
                provider: Provider::Expo,
                partner: None,
                gateway: None,
                may_approve: true,
            })
            .unwrap();
        }
        assert_eq!(p.regs().len(), MAX_REGS);
        assert_eq!(p.unregister(None, Some("p0")), MAX_REGS / 2);
        assert_eq!(p.unregister(Some("ExpoPushToken[token00000039]"), None), 1);
    }

    const ALL: PushPrefs = PushPrefs {
        print_done: true,
        print_failed: true,
        attention: true,
        approvals: true,
    };

    fn partner(tag: &str, token: &str, provider: Provider, gateway: Option<&str>) -> PushReg {
        PushReg {
            token: token.into(),
            platform: "ios".into(),
            prefs: ALL,
            tag: Some(tag.into()),
            created_at_ms: 0,
            provider,
            partner: Some("Example Phone".into()),
            gateway: gateway.map(str::to_owned),
            may_approve: true,
        }
    }

    #[test]
    fn partner_tokens_are_checked_per_provider() {
        let apns = "a".repeat(64);
        assert!(valid_device_token(Provider::Apns, &apns));
        assert!(!valid_device_token(Provider::Apns, "zz"));
        assert!(!valid_device_token(Provider::Apns, &"g".repeat(64)));
        assert!(valid_device_token(
            Provider::Fcm,
            "dGVzdA:APA91bH-xyz_0123456789abcdefghijkl"
        ));
        assert!(!valid_device_token(Provider::Fcm, "short"));
        assert!(!valid_device_token(
            Provider::Fcm,
            &format!("{} space", "x".repeat(40))
        ));
        assert!(valid_device_token(
            Provider::Expo,
            "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"
        ));
        assert!(!valid_device_token(Provider::Expo, &apns));
    }

    #[test]
    fn a_gateway_is_https_on_a_public_name_only() {
        for ok in [
            "https://push.example.com/v1/slicerx",
            "https://push.example.com",
            "https://a.b.example:8443/x",
        ] {
            assert!(valid_gateway(ok, false), "{ok}");
        }
        for bad in [
            "http://push.example.com/x",
            "https://127.0.0.1/x",
            "https://[::1]/x",
            "https://10.0.0.2/x",
            "https://printer.local/x",
            "https://router.lan/x",
            "https://localhost/x",
            "https://intranet/x",
            "https://user:pw@push.example.com/x",
            "https://push.example.com/x?token=1",
            "https://push.example.com/x#f",
            "ftp://push.example.com/x",
        ] {
            assert!(!valid_gateway(bad, false), "{bad}");
        }
        // Tests point Expo at this machine, and then a local gateway is allowed.
        assert!(valid_gateway("http://127.0.0.1:9/push", true));
        assert!(!valid_gateway(
            &format!("https://push.example.com/{}", "x".repeat(200)),
            false
        ));
    }

    #[test]
    fn gateway_addresses_must_be_public() {
        // 6to4 of a public IPv4 address is public.
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2002:808:808::1"] {
            assert!(public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "0.0.0.0",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "fd00::1",
            "fe80::1",
            "::ffff:192.168.1.1",
            "192.0.0.8",
            "64:ff9b::a00:1",
            "64:ff9b::808:808",
            "64:ff9b:1::1",
            "::a00:1",
            "::808:808",
            "fec0::1",
            "2002:a00:1::1",
            "2002:c0a8:101::1",
            "2001:db8::1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn a_partner_phone_keeps_one_registration_and_partners_are_capped() {
        let p = Pusher::new("", Vec::new());
        p.register(partner(
            "pair-a",
            "ExpoPushToken[aaaaaaaaaaaa]",
            Provider::Expo,
            None,
        ))
        .unwrap();
        p.register(partner(
            "pair-a",
            "ExpoPushToken[bbbbbbbbbbbb]",
            Provider::Expo,
            None,
        ))
        .unwrap();
        let a: Vec<_> = p
            .regs()
            .into_iter()
            .filter(|r| r.tag.as_deref() == Some("pair-a"))
            .collect();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].token, "ExpoPushToken[bbbbbbbbbbbb]");
        for i in 0..(MAX_PARTNER_REGS + 4) {
            p.register(partner(
                &format!("pair-{i}"),
                &format!("ExpoPushToken[cccccccc{i:04}]"),
                Provider::Expo,
                None,
            ))
            .unwrap();
        }
        assert_eq!(
            p.regs().iter().filter(|r| r.partner.is_some()).count(),
            MAX_PARTNER_REGS
        );
        // Our own phones are not pushed out by partners.
        p.register(PushReg {
            partner: None,
            tag: Some("own".into()),
            ..partner("own", "ExpoPushToken[ownownownown]", Provider::Expo, None)
        })
        .unwrap();
        for i in 0..4 {
            p.register(partner(
                &format!("more-{i}"),
                &format!("ExpoPushToken[dddddddd{i:04}]"),
                Provider::Expo,
                None,
            ))
            .unwrap();
        }
        assert!(p.regs().iter().any(|r| r.tag.as_deref() == Some("own")));
    }

    #[test]
    fn a_partner_phone_gets_a_capped_number_of_pushes_an_hour() {
        let p = Pusher::new("", Vec::new());
        let t0 = 10 * HOUR_MS;
        for _ in 0..PARTNER_PUSHES_PER_HOUR {
            assert!(p.partner_allowance("pair-a", t0));
        }
        assert!(!p.partner_allowance("pair-a", t0 + 1));
        assert!(
            p.partner_allowance("pair-b", t0 + 2),
            "another phone has its own allowance"
        );
        assert_eq!(p.partner_sent("pair-a", t0), PARTNER_PUSHES_PER_HOUR);
        // The window slides: half an hour on, the hour still holds 30, and a burst at the turn of the
        // clock hour gets no second allowance.
        assert!(!p.partner_allowance("pair-a", t0 + HOUR_MS / 2));
        assert!(
            p.partner_allowance("pair-a", t0 + HOUR_MS),
            "an hour after the first, room again"
        );
        let edge = 20 * HOUR_MS - 1000;
        for _ in 0..PARTNER_PUSHES_PER_HOUR {
            assert!(p.partner_allowance("pair-c", edge));
        }
        assert!(
            !p.partner_allowance("pair-c", edge + 2000),
            "a new clock hour is not a new window"
        );
    }

    #[test]
    fn a_token_another_phone_holds_is_refused_and_our_phone_wins_it_back() {
        let p = Pusher::new("", Vec::new());
        p.register(partner(
            "pair-a",
            "ExpoPushToken[sharedsharedx]",
            Provider::Expo,
            None,
        ))
        .unwrap();
        let e = p
            .register(partner(
                "pair-b",
                "ExpoPushToken[sharedsharedx]",
                Provider::Expo,
                None,
            ))
            .unwrap_err();
        assert_eq!(e.code, "conflict");
        assert_eq!(p.regs().len(), 1, "the first partner phone keeps it");
        // Our own phone's registration (through the app) wins over a partner that took its token
        // first, and the partner then hears conflict.
        let own = PushReg {
            partner: None,
            tag: Some("own".into()),
            ..partner("own", "ExpoPushToken[sharedsharedx]", Provider::Expo, None)
        };
        p.register(own).unwrap();
        let kept: Vec<_> = p
            .regs()
            .into_iter()
            .map(|r| (r.tag, r.partner.is_some()))
            .collect();
        assert_eq!(kept, vec![(Some("own".to_owned()), false)]);
        let e = p
            .register(partner(
                "pair-a",
                "ExpoPushToken[sharedsharedx]",
                Provider::Expo,
                None,
            ))
            .unwrap_err();
        assert_eq!(e.code, "conflict");
        // Between two of our own phones the first keeps it.
        let other = PushReg {
            partner: None,
            tag: Some("own-2".into()),
            ..partner("own-2", "ExpoPushToken[sharedsharedx]", Provider::Expo, None)
        };
        assert!(p.register(other).is_err());
    }

    #[test]
    fn partner_params_need_the_right_gateway_and_clear_approvals_without_the_right() {
        let p = Pusher::new("", Vec::new());
        let prefs = json!({ "printDone": true, "printFailed": true, "attention": true, "approvals": true });
        let expo = json!({ "provider": "expo", "token": "ExpoPushToken[abcdefghijkl]", "platform": "ios", "prefs": prefs });
        let r = partner_reg(&p, &expo, "t".into(), "Example Phone".into(), false).unwrap();
        assert!(
            !r.may_approve && r.prefs.approvals,
            "a phone without the approve right gets no approval alerts, and keeps its choice for later"
        );
        assert_eq!(r.provider, Provider::Expo);
        let with_gw = json!({ "provider": "expo", "token": "ExpoPushToken[abcdefghijkl]", "platform": "ios", "prefs": prefs, "gateway": "https://push.example.com/x" });
        assert!(partner_reg(&p, &with_gw, "t".into(), "Example Phone".into(), true).is_err());
        let apns = json!({ "provider": "apns", "token": "ab".repeat(32), "platform": "ios", "prefs": prefs });
        assert!(
            partner_reg(&p, &apns, "t".into(), "Example Phone".into(), true).is_err(),
            "apns needs a gateway"
        );
        let local = json!({ "provider": "apns", "token": "ab".repeat(32), "platform": "ios", "prefs": prefs, "gateway": "https://10.0.0.5/push" });
        assert!(partner_reg(&p, &local, "t".into(), "Example Phone".into(), true).is_err());
        let ok = json!({ "provider": "fcm", "token": "f".repeat(40), "platform": "android", "prefs": prefs, "gateway": "https://push.example.com/fcm" });
        let r = partner_reg(&p, &ok, "t".into(), "Example Phone".into(), true).unwrap();
        assert!(r.may_approve);
        assert_eq!(r.gateway.as_deref(), Some("https://push.example.com/fcm"));
        let bad = json!({ "provider": "webpush", "token": "x", "platform": "ios", "prefs": prefs });
        assert!(partner_reg(&p, &bad, "t".into(), "Example Phone".into(), true).is_err());
    }

    /// A fake push service: answers every POST with `reply` and sends (path, headers, body) of each.
    async fn fake_service(
        reply: Value,
    ) -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<(String, String, Value)>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let (tx, reply) = (tx.clone(), reply.clone());
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 8192];
                    loop {
                        let n = sock.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        let text = String::from_utf8_lossy(&buf).to_string();
                        if let Some(i) = text.find("\r\n\r\n") {
                            let head = text[..i].to_ascii_lowercase();
                            let len: usize = head
                                .lines()
                                .find_map(|l| {
                                    l.strip_prefix("content-length:")
                                        .map(|v| v.trim().parse().unwrap_or(0))
                                })
                                .unwrap_or(0);
                            if buf.len() >= i + 4 + len {
                                let path = head.split_whitespace().nth(1).unwrap_or("").to_owned();
                                let body: Value =
                                    serde_json::from_slice(&buf[i + 4..i + 4 + len]).unwrap_or(Value::Null);
                                let _ = tx.send((path, head, body));
                                let out = reply.to_string();
                                let resp = format!(
                                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{out}",
                                    out.len()
                                );
                                let _ = sock.write_all(resp.as_bytes()).await;
                                return;
                            }
                        }
                    }
                });
            }
        });
        (base, rx)
    }

    async fn next(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<(String, String, Value)>,
    ) -> (String, String, Value) {
        tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("a post in time")
            .expect("open")
    }

    #[tokio::test]
    async fn partner_pushes_go_out_on_their_own_without_our_token_or_a_printer_id() {
        let (base, mut rx) = fake_service(json!({ "data": [{ "status": "ok" }] })).await;
        let p = Pusher::new(&format!("{base}/expo"), Vec::new());
        p.register(PushReg {
            partner: None,
            ..partner("own", "ExponentPushToken[ownownownownown]", Provider::Expo, None)
        })
        .unwrap();
        p.register(partner(
            "pair-x",
            "ExponentPushToken[partnerpartner1]",
            Provider::Expo,
            None,
        ))
        .unwrap();
        p.register(partner(
            "pair-y",
            &"ab".repeat(32),
            Provider::Apns,
            Some(&format!("{base}/gateway")),
        ))
        .unwrap();
        // pair-w was told by the app (on the LAN) that it may no longer approve.
        p.register(partner(
            "pair-w",
            "ExponentPushToken[partnerpartner3]",
            Provider::Expo,
            None,
        ))
        .unwrap();
        assert_eq!(p.set_may_approve("pair-w", false), 1);
        // pair-z may not approve: it gets no approval alert.
        p.register(partner(
            "pair-z",
            "ExponentPushToken[partnerpartner2]",
            Provider::Expo,
            None,
        ))
        .unwrap();
        let no = HashSet::from(["pair-z".to_owned()]);
        p.notify(
            PushKind::Approval,
            Some("Bay 4 printer"),
            Some("req-1"),
            Some("our-secret-token".into()),
            &no,
        );
        let mut posts = Vec::new();
        for _ in 0..3 {
            posts.push(next(&mut rx).await);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(rx.try_recv().is_err(), "pair-z got an approval push");
        let own = posts
            .iter()
            .find(|(path, _, b)| path == "/expo" && b[0]["to"] == "ExponentPushToken[ownownownownown]")
            .expect("our push");
        assert!(own.1.contains("authorization: bearer our-secret-token"));
        assert_eq!(
            own.2.as_array().unwrap().len(),
            1,
            "our post carries only our phone"
        );
        assert_eq!(own.2[0]["data"]["printerId"], "Bay 4 printer");
        let theirs = posts
            .iter()
            .find(|(path, _, b)| path == "/expo" && b[0]["to"] == "ExponentPushToken[partnerpartner1]")
            .expect("partner expo push");
        assert!(
            !theirs.1.contains("authorization"),
            "our token went with a partner's push"
        );
        assert_eq!(theirs.2[0]["data"], json!({ "kind": "approval" }));
        let gw = posts
            .iter()
            .find(|(path, _, _)| path == "/gateway")
            .expect("gateway push");
        assert!(!gw.1.contains("authorization"));
        assert_eq!(gw.2["provider"], "apns");
        assert_eq!(gw.2["token"], "ab".repeat(32));
        assert_eq!(gw.2["data"], json!({ "kind": "approval" }));
        let (title, body) = PushKind::Approval.text();
        assert_eq!(gw.2["title"], title);
        assert_eq!(gw.2["body"], body);
        for (_, _, b) in &posts {
            assert!(!b.to_string().contains("Bay 4") || b[0]["to"] == "ExponentPushToken[ownownownownown]");
        }
    }

    #[tokio::test]
    async fn a_gateway_on_a_local_address_gets_nothing_on_a_real_hub() {
        let (base, mut rx) = fake_service(json!({})).await;
        assert!(!post_gateway(&format!("{base}/gateway"), &json!({}), false).await);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(rx.try_recv().is_err(), "the hub posted to a local gateway");
        assert!(!post_gateway(&format!("{base}/gateway"), &json!({}), true).await);
        assert_eq!(next(&mut rx).await.0, "/gateway");
    }
}
