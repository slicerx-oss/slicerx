// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Phone alerts while the app is closed. A paired phone registers its Expo push token through the
//! app (`push.register`); when the watcher sees a print finish, fail or stop, or the hub raises an
//! approval card, the hub posts one push per registered phone to Expo's push service.
//!
//! The text a push shows travels through Expo and Apple or Google, so it is fixed and names no
//! file, model or printer. `data` carries the alert kind and the printer id for routing a tap; the
//! phone loads everything else over the paired channel when it opens.
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
    pub(crate) fn text(self) -> (&'static str, &'static str) {
        match self {
            PushKind::PrintDone => ("Print finished", "A printer is done. Open SlicerX to see which."),
            PushKind::PrintFailed => (
                "Print stopped",
                "A print did not finish. Open SlicerX for details.",
            ),
            PushKind::Attention => (
                "A printer needs you",
                "Open SlicerX to see what it is waiting for.",
            ),
            PushKind::Approval => (
                "Approval waiting",
                "Something is waiting for your answer in SlicerX.",
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
        }
    }

    pub(crate) fn regs(&self) -> Vec<PushReg> {
        lock(&self.regs).clone()
    }

    /// True once after the registrations changed (a phone was removed after Expo refused it).
    pub(crate) fn take_changed(&self) -> bool {
        self.changed.swap(false, Ordering::Relaxed)
    }

    fn register(&self, reg: PushReg) {
        let mut r = lock(&self.regs);
        r.retain(|x| x.token != reg.token);
        r.push(reg);
        while r.len() > MAX_REGS {
            r.remove(0);
        }
    }

    fn unregister(&self, token: Option<&str>, tag: Option<&str>) -> usize {
        let mut r = lock(&self.regs);
        let before = r.len();
        r.retain(|x| token.is_none_or(|t| x.token != t) && tag.is_none_or(|t| x.tag.as_deref() != Some(t)));
        before - r.len()
    }

    /// Sends `kind` to every phone that wants it. Returns at once; the post runs in the background.
    pub(crate) fn notify(
        &self,
        kind: PushKind,
        printer_id: Option<&str>,
        request_id: Option<&str>,
        access_token: Option<String>,
    ) {
        let Some(client) = self.client.clone() else { return };
        let tokens: Vec<String> = lock(&self.regs)
            .iter()
            .filter(|r| kind.wanted(r.prefs))
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
}

/// Sends a push for one hub alert, if the alert kind calls for one.
pub(crate) fn alert(b: &Bridge, alert: &str, printer_id: Option<&str>, request_id: Option<&str>) {
    if let Some(kind) = PushKind::for_alert(alert) {
        let token = sx_connect::Secrets::get(b.secrets_ref(), ACCESS_TOKEN_SECRET);
        b.hub.push.notify(kind, printer_id, request_id, token);
    }
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
            });
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
        // Tokens are not echoed back; the last characters are enough to tell phones apart.
        "push.list" => Ok(Value::Array(
            b.hub
                .push
                .regs()
                .iter()
                .map(|r| {
                    json!({
                        "tokenEnd": tail(&r.token), "platform": r.platform, "prefs": r.prefs,
                        "tag": r.tag, "createdAt": crate::hub::iso(r.created_at_ms),
                    })
                })
                .collect(),
        )),
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
            });
        }
        assert_eq!(p.regs().len(), MAX_REGS);
        assert_eq!(p.unregister(None, Some("p0")), MAX_REGS / 2);
        assert_eq!(p.unregister(Some("ExpoPushToken[token00000039]"), None), 1);
    }
}
