// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The approval broker. Same rules as `packages/pilot/src/permit/broker.ts`.
use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

use crate::canonical::canonical_json;
use crate::error::{Error, Result};
use crate::start::StartOrigin;
use crate::types::{ApprovalAction, ApprovalRequest, ApprovalToken};

/// How long a granted token stays valid.
pub const TOKEN_TTL: Duration = Duration::from_mins(5);

/// Bytes of randomness in the per-broker HMAC secret.
const SECRET_LEN: usize = 32;

/// Wall clock used for token expiry. Injected so tests can move time.
pub trait Clock: Send + Sync {
    /// The current time.
    fn now(&self) -> SystemTime;
}

/// [`Clock`] backed by [`SystemTime::now`].
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

enum State {
    Pending,
    Granted { expires_ms: u64, bed_confirmed: bool },
    Denied,
}

/// What the person answered on a granted card, for the start rules in [`crate::start`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantInfo {
    /// The request's origin; `None` counts as remote.
    pub origin: Option<StartOrigin>,
    /// The person said the bed is clear when approving.
    pub bed_confirmed: bool,
    /// The printer the request is about.
    pub printer_id: Option<String>,
}

struct Entry {
    /// Owned copy, so the caller cannot change what was approved after `register`.
    req: ApprovalRequest,
    state: State,
    /// One flag per action in `req.actions`.
    used: Vec<bool>,
}

/// Registers approval requests, mints single-use tokens after the user approves, and
/// verifies them for every host call with a side effect. Safe to share between threads.
///
/// ```
/// use sx_permit::{hash_params, ApprovalAction, ApprovalBroker, ApprovalRequest, PermissionClass};
/// let broker = ApprovalBroker::new()?;
/// let params = hash_params(&serde_json::json!({"printerId": "bay-1"}));
/// broker.register(ApprovalRequest {
///     id: "req-1".into(),
///     session_id: "s-1".into(),
///     tool: "moonraker.pause".into(),
///     permission: PermissionClass::Start,
///     title: "Pause Bay 1?".into(),
///     lines: vec![],
///     printer_id: Some("bay-1".into()),
///     params_hash: params.clone(),
///     actions: vec![ApprovalAction { action: "printer.pause".into(), target: "bay-1".into(), params_hash: params.clone() }],
///     expires_at: "2099-09-30T12:00:00.000Z".into(),
///     origin: None,
/// })?;
/// let token = broker.grant("req-1")?;
/// broker.verify(&token, "printer.pause", "bay-1", &params)?;
/// assert!(broker.verify(&token, "printer.pause", "bay-1", &params).is_err());
/// # Ok::<(), sx_permit::Error>(())
/// ```
pub struct ApprovalBroker {
    /// Keyed with the random secret; cloned for each signature so the secret bytes are
    /// not kept anywhere else.
    mac: Hmac<Sha256>,
    clock: Box<dyn Clock>,
    entries: Mutex<HashMap<String, Entry>>,
}

impl std::fmt::Debug for ApprovalBroker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApprovalBroker").finish_non_exhaustive()
    }
}

impl ApprovalBroker {
    /// A broker with a fresh random secret and the system clock.
    pub fn new() -> Result<Self> {
        Self::with_clock(SystemClock)
    }

    /// A broker with a fresh random secret and the given clock.
    pub fn with_clock(clock: impl Clock + 'static) -> Result<Self> {
        // HMAC zero-pads keys shorter than the SHA-256 block, so keying with the 32 random
        // bytes followed by zeros is HMAC keyed with the 32 byte secret.
        let mut key = [0u8; 64];
        let (secret, _) = key.split_at_mut(SECRET_LEN);
        getrandom::fill(secret).map_err(|_| Error::Random)?;
        let mac = <Hmac<Sha256> as KeyInit>::new(&key.into());
        key.fill(0);
        Ok(Self {
            mac,
            clock: Box::new(clock),
            entries: Mutex::new(HashMap::new()),
        })
    }

    /// Registers a pending request. Fails for a repeated id, or when an action has an
    /// empty target or a parameter hash that is not 64 lowercase hex characters.
    pub fn register(&self, req: ApprovalRequest) -> Result<()> {
        // Only the hub mints these two, never a card.
        if matches!(req.origin, Some(StartOrigin::LocalClick | StartOrigin::Watch)) {
            return Err(Error::Origin { request_id: req.id });
        }
        self.insert(req)
    }

    /// Brings a card's expiry to at most `max_ttl` from now, so a caller cannot hold a waiting
    /// slot for days. An expiry that does not parse becomes `now + max_ttl` too, instead of a card
    /// that is never open. The hub calls it on agent cards before showing or registering them.
    pub fn cap_expiry(&self, req: &mut ApprovalRequest, max_ttl: Duration) {
        let now = now_ms(self.clock.as_ref());
        let cap = now.saturating_add(u64::try_from(max_ttl.as_millis()).unwrap_or(u64::MAX));
        if parse_iso8601_ms(&req.expires_at).is_none_or(|exp| exp > cap) {
            req.expires_at = iso8601_ms(cap);
        }
    }

    fn insert(&self, req: ApprovalRequest) -> Result<()> {
        if let Some(index) = req.actions.iter().position(|a| !valid_action(a)) {
            return Err(Error::MalformedAction {
                request_id: req.id,
                index,
            });
        }
        let mut entries = self.lock();
        if entries.contains_key(&req.id) {
            return Err(Error::Duplicate { request_id: req.id });
        }
        let used = vec![false; req.actions.len()];
        entries.insert(
            req.id.clone(),
            Entry {
                req,
                state: State::Pending,
                used,
            },
        );
        Ok(())
    }

    /// Approves a pending request and mints its token, valid for [`TOKEN_TTL`]. Call it
    /// only from the approval card's button handler. A request can be granted once.
    pub fn grant(&self, request_id: &str) -> Result<ApprovalToken> {
        self.grant_with(request_id, false)
    }

    /// Like [`Self::grant`], and records whether the person also said the bed is clear (the card's
    /// bed question). Starts check it through [`Self::grant_info`].
    pub fn grant_with(&self, request_id: &str, bed_confirmed: bool) -> Result<ApprovalToken> {
        self.grant_inner(request_id, bed_confirmed, true)
    }

    fn grant_inner(&self, request_id: &str, bed_confirmed: bool, card: bool) -> Result<ApprovalToken> {
        let now = now_ms(self.clock.as_ref());
        let mut entries = self.lock();
        let entry = entries.get_mut(request_id).ok_or_else(|| Error::Unknown {
            request_id: request_id.to_owned(),
        })?;
        match entry.state {
            State::Pending => {}
            State::Granted { .. } => return Err(not_pending(request_id, "granted")),
            State::Denied => return Err(not_pending(request_id, "denied")),
        }
        // A card shown past its time may show a stale picture of the printer: it cannot be approved.
        match parse_iso8601_ms(&entry.req.expires_at) {
            _ if !card => {}
            Some(exp) if now < exp => {}
            _ => {
                entry.state = State::Denied;
                return Err(Error::Expired);
            }
        }
        let ttl_ms = u64::try_from(TOKEN_TTL.as_millis()).unwrap_or(u64::MAX);
        let expires_ms = now.saturating_add(ttl_ms);
        entry.state = State::Granted {
            expires_ms,
            bed_confirmed,
        };
        let tag = self.sign(&entry.req, expires_ms).finalize().into_bytes();
        Ok(ApprovalToken {
            request_id: request_id.to_owned(),
            token: URL_SAFE_NO_PAD.encode(tag),
            expires_at: iso8601_ms(expires_ms),
        })
    }

    /// Denies a request. A granted request is revoked, so its token stops verifying.
    /// Unknown ids are ignored, as in the TypeScript broker.
    pub fn deny(&self, request_id: &str) -> Result<()> {
        if let Some(entry) = self.lock().get_mut(request_id) {
            entry.state = State::Denied;
        }
        Ok(())
    }

    /// Checks `token` for one host call and consumes that action on success, so a second
    /// call with the same token, action, target and parameter hash fails with
    /// [`Error::Used`]. Checks run in the TypeScript broker's order: unknown, denied,
    /// signature, expiry, match, reuse.
    pub fn verify(&self, token: &ApprovalToken, action: &str, target: &str, params_hash: &str) -> Result<()> {
        self.inspect(token, action, target, params_hash, true)
    }

    /// Runs every check [`Self::verify`] runs without using the action up, so a caller can refuse
    /// early (and leave state alone) for a token that would not verify.
    pub fn check(&self, token: &ApprovalToken, action: &str, target: &str, params_hash: &str) -> Result<()> {
        self.inspect(token, action, target, params_hash, false)
    }

    fn inspect(
        &self,
        token: &ApprovalToken,
        action: &str,
        target: &str,
        params_hash: &str,
        consume: bool,
    ) -> Result<()> {
        let now = now_ms(self.clock.as_ref());
        let mut entries = self.lock();
        let unknown = || Error::Unknown {
            request_id: token.request_id.clone(),
        };
        let entry = entries.get_mut(&token.request_id).ok_or_else(unknown)?;
        let expires_ms = match entry.state {
            State::Denied => {
                return Err(Error::Denied {
                    request_id: token.request_id.clone(),
                });
            }
            State::Pending => return Err(unknown()),
            State::Granted { expires_ms, .. } => expires_ms,
        };
        let tag = URL_SAFE_NO_PAD
            .decode(token.token.as_bytes())
            .map_err(|_| Error::BadSignature)?;
        // `verify_slice` compares in constant time.
        self.sign(&entry.req, expires_ms)
            .verify_slice(&tag)
            .map_err(|_| Error::BadSignature)?;
        if now >= expires_ms {
            return Err(Error::Expired);
        }
        let call = || (action.to_owned(), target.to_owned());
        let index = entry
            .req
            .actions
            .iter()
            .position(|a| a.action == action && a.target == target && a.params_hash == params_hash)
            .ok_or_else(|| {
                let (action, target) = call();
                Error::Mismatch { action, target }
            })?;
        match entry.used.get_mut(index) {
            Some(used) if !*used => {
                if consume {
                    *used = true;
                }
                Ok(())
            }
            _ => {
                let (action, target) = call();
                Err(Error::Used { action, target })
            }
        }
    }

    /// Registers and grants `req` in one step, for starts the hub has already authorized: the
    /// person's own Print click (origin `local_click`) or a queued or scheduled start whose standing
    /// approval came due (`queue`, `schedule`). Never reachable through `register` and `grant`, so a
    /// card-based caller cannot claim a local click. Other origins are refused.
    pub fn mint(&self, req: ApprovalRequest, bed_confirmed: bool) -> Result<ApprovalToken> {
        let allowed = match req.origin {
            Some(StartOrigin::LocalClick | StartOrigin::Queue | StartOrigin::Schedule) => true,
            // The watch may pause a print, and turn heaters off after a pause nobody answered
            // (the hub builds those changes itself); never start, resume or send G-code.
            Some(StartOrigin::Watch) => {
                !req.actions.is_empty()
                    && req
                        .actions
                        .iter()
                        .all(|a| a.action == "printer.pause" || a.action == "printer.adjust")
            }
            _ => false,
        };
        if !allowed {
            return Err(Error::Origin { request_id: req.id });
        }
        let id = req.id.clone();
        self.insert(req)?;
        // No card was shown, so there is no card time to check; the token still lives TOKEN_TTL.
        self.grant_inner(&id, bed_confirmed, false)
    }

    /// Origin and bed answer of a granted request; `None` for unknown, pending, denied or expired ones.
    pub fn grant_info(&self, request_id: &str) -> Option<GrantInfo> {
        let now = now_ms(self.clock.as_ref());
        let entries = self.lock();
        let entry = entries.get(request_id)?;
        match entry.state {
            State::Granted { expires_ms, .. } if now >= expires_ms => None,
            State::Granted { bed_confirmed, .. } => Some(GrantInfo {
                origin: entry.req.origin,
                bed_confirmed,
                printer_id: entry.req.printer_id.clone(),
            }),
            State::Pending | State::Denied => None,
        }
    }

    /// A copy of a registered request, whatever its state.
    pub fn request(&self, request_id: &str) -> Option<ApprovalRequest> {
        self.lock().get(request_id).map(|e| e.req.clone())
    }

    /// True while a request waits for a decision and its card has not expired. Held work for a card
    /// that is no longer open can be dropped.
    pub fn is_open(&self, request_id: &str) -> bool {
        let now = now_ms(self.clock.as_ref());
        self.lock().get(request_id).is_some_and(|e| {
            matches!(e.state, State::Pending)
                && parse_iso8601_ms(&e.req.expires_at).is_some_and(|exp| now < exp)
        })
    }

    /// Ids of requests still waiting for a decision.
    pub fn pending(&self) -> Vec<String> {
        self.lock()
            .values()
            .filter(|e| matches!(e.state, State::Pending))
            .map(|e| e.req.id.clone())
            .collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        // A panic while holding the lock cannot leave an entry half written: every update
        // is a single field assignment.
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// HMAC over the same payload the TypeScript broker signs.
    fn sign(&self, req: &ApprovalRequest, expires_ms: u64) -> Hmac<Sha256> {
        let actions: Vec<Value> = req
            .actions
            .iter()
            .map(|a| json!({"action": a.action, "target": a.target, "paramsHash": a.params_hash}))
            .collect();
        let payload = canonical_json(&json!({
            "id": req.id,
            "session": req.session_id,
            "tool": req.tool,
            "params": req.params_hash,
            "actions": actions,
            "exp": expires_ms,
        }));
        let mut mac = self.mac.clone();
        mac.update(payload.as_bytes());
        mac
    }
}

fn not_pending(request_id: &str, state: &'static str) -> Error {
    Error::NotPending {
        request_id: request_id.to_owned(),
        state,
    }
}

fn valid_action(a: &ApprovalAction) -> bool {
    !a.target.is_empty()
        && a.params_hash.len() == 64
        && a.params_hash
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn now_ms(clock: &dyn Clock) -> u64 {
    clock
        .now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Milliseconds since the Unix epoch as `Date.prototype.toISOString` writes them
/// (`2026-09-30T12:05:00.000Z`), for years 0 to 9999.
fn iso8601_ms(ms: u64) -> String {
    let days = i64::try_from(ms / 86_400_000).unwrap_or(i64::MAX);
    let rem = ms % 86_400_000;
    let (hour, minute, second, milli) = (rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z")
}

/// Parses `YYYY-MM-DDTHH:MM:SS[.fff]Z` (what `toISOString` writes) to ms since the epoch. `None`
/// for anything else, which the broker treats as already expired.
pub(crate) fn parse_iso8601_ms(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    let num = |from: usize, to: usize| -> Option<i64> {
        let part = text.get(from..to)?;
        if part.bytes().all(|c| c.is_ascii_digit()) {
            part.parse().ok()
        } else {
            None
        }
    };
    let shape_ok = bytes.len() >= 20
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':')
        && bytes.last() == Some(&b'Z');
    if !shape_ok {
        return None;
    }
    let year = num(0, 4)?;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    let hour = num(11, 13)?;
    let minute = num(14, 16)?;
    let second = num(17, 19)?;
    let milli = match text.get(19..text.len() - 1)? {
        "" => 0,
        frac => {
            let digits = frac.strip_prefix('.')?;
            if digits.is_empty() || digits.len() > 9 || !digits.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let first3: String = digits.chars().chain("000".chars()).take(3).collect();
            first3.parse().ok()?
        }
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    // Howard Hinnant's days_from_civil.
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = shifted.div_euclid(400);
    let yoe = shifted - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let total = days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000 + milli;
    u64::try_from(total).ok()
}

/// Proleptic Gregorian date for a day count since 1970-01-01 (Howard Hinnant's
/// `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days.saturating_add(719_468);
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::canonical::hash_params;
    use crate::types::PermissionClass;

    const START_MS: u64 = 1_790_000_000_123;

    #[derive(Clone)]
    struct FakeClock(Arc<AtomicU64>);

    impl FakeClock {
        fn advance(&self, d: Duration) {
            self.0
                .fetch_add(u64::try_from(d.as_millis()).unwrap(), Ordering::SeqCst);
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> SystemTime {
            UNIX_EPOCH + Duration::from_millis(self.0.load(Ordering::SeqCst))
        }
    }

    fn broker() -> (ApprovalBroker, FakeClock) {
        let clock = FakeClock(Arc::new(AtomicU64::new(START_MS)));
        (ApprovalBroker::with_clock(clock.clone()).unwrap(), clock)
    }

    fn pause_hash(printer: &str) -> String {
        hash_params(&json!({ "printerId": printer }))
    }

    fn action(action: &str, target: &str) -> ApprovalAction {
        ApprovalAction {
            action: action.into(),
            target: target.into(),
            params_hash: pause_hash(target),
        }
    }

    fn request(id: &str, actions: Vec<ApprovalAction>) -> ApprovalRequest {
        ApprovalRequest {
            id: id.into(),
            session_id: "session-1".into(),
            tool: "moonraker.pause".into(),
            permission: PermissionClass::Start,
            title: "Pause Bay 1?".into(),
            lines: vec!["Layer 148 of 238".into()],
            printer_id: Some("bay-1".into()),
            params_hash: pause_hash("bay-1"),
            actions,
            expires_at: "2026-09-21T14:18:20.123Z".into(),
            origin: None,
        }
    }

    fn granted(b: &ApprovalBroker) -> ApprovalToken {
        b.register(request("req-1", vec![action("printer.pause", "bay-1")]))
            .unwrap();
        b.grant("req-1").unwrap()
    }

    #[test]
    fn a_card_is_open_until_answered_or_past_its_time() {
        let (b, clock) = broker();
        b.register(request("req-1", vec![action("printer.pause", "bay-1")]))
            .unwrap();
        b.register(request("req-2", vec![action("printer.pause", "bay-1")]))
            .unwrap();
        assert!(b.is_open("req-1") && b.is_open("req-2"));
        b.deny("req-2").unwrap();
        assert!(!b.is_open("req-2"));
        assert!(!b.is_open("unknown"));
        // Still pending at the broker, but past the card's time: no longer open.
        clock.advance(Duration::from_secs(3600));
        assert!(!b.is_open("req-1"));
        assert!(b.pending().contains(&"req-1".to_owned()));
    }

    #[test]
    fn grant_then_verify_once() {
        let (b, _) = broker();
        let t = granted(&b);
        assert_eq!(t.request_id, "req-1");
        assert_eq!(t.expires_at, "2026-09-21T14:18:20.123Z");
        b.verify(&t, "printer.pause", "bay-1", &pause_hash("bay-1"))
            .unwrap();
    }

    #[test]
    fn token_cannot_be_reused() {
        let (b, _) = broker();
        let t = granted(&b);
        let h = pause_hash("bay-1");
        b.verify(&t, "printer.pause", "bay-1", &h).unwrap();
        let err = b.verify(&t, "printer.pause", "bay-1", &h).unwrap_err();
        assert!(matches!(err, Error::Used { .. }), "{err:?}");
        assert_eq!(err.failure_reason(), Some("used"));
    }

    #[test]
    fn token_for_another_printer_fails() {
        let (b, _) = broker();
        let t = granted(&b);
        let err = b
            .verify(&t, "printer.pause", "bay-2", &pause_hash("bay-1"))
            .unwrap_err();
        assert!(matches!(err, Error::Mismatch { .. }), "{err:?}");
        // A mismatch does not consume the action.
        b.verify(&t, "printer.pause", "bay-1", &pause_hash("bay-1"))
            .unwrap();
    }

    #[test]
    fn token_for_other_params_or_action_fails() {
        let (b, _) = broker();
        let t = granted(&b);
        let err = b
            .verify(&t, "printer.pause", "bay-1", &pause_hash("bay-2"))
            .unwrap_err();
        assert!(matches!(err, Error::Mismatch { .. }), "{err:?}");
        let err = b
            .verify(&t, "printer.start", "bay-1", &pause_hash("bay-1"))
            .unwrap_err();
        assert!(matches!(err, Error::Mismatch { .. }), "{err:?}");
    }

    #[test]
    fn expired_token_fails() {
        let (b, clock) = broker();
        let t = granted(&b);
        clock.advance(TOKEN_TTL.checked_sub(Duration::from_millis(1)).unwrap());
        let h = pause_hash("bay-1");
        assert!(b.verify(&t, "printer.pause", "bay-2", &h).is_err());
        clock.advance(Duration::from_millis(1));
        let err = b.verify(&t, "printer.pause", "bay-1", &h).unwrap_err();
        assert_eq!(err, Error::Expired);
    }

    #[test]
    fn denied_request_cannot_be_granted_or_used() {
        let (b, _) = broker();
        b.register(request("req-1", vec![action("printer.pause", "bay-1")]))
            .unwrap();
        b.deny("req-1").unwrap();
        let err = b.grant("req-1").unwrap_err();
        assert!(
            matches!(err, Error::NotPending { state: "denied", .. }),
            "{err:?}"
        );
        assert!(b.pending().is_empty());
    }

    #[test]
    fn deny_after_grant_revokes_the_token() {
        let (b, _) = broker();
        let t = granted(&b);
        b.deny("req-1").unwrap();
        let err = b
            .verify(&t, "printer.pause", "bay-1", &pause_hash("bay-1"))
            .unwrap_err();
        assert!(matches!(err, Error::Denied { .. }), "{err:?}");
        // Unknown ids are ignored, as in the TypeScript broker.
        b.deny("nope").unwrap();
    }

    #[test]
    fn tampered_token_fails() {
        let (b, _) = broker();
        let t = granted(&b);
        let h = pause_hash("bay-1");
        let mut bad = t.clone();
        let first = if bad.token.starts_with('A') { "B" } else { "A" };
        bad.token.replace_range(0..1, first);
        assert_eq!(
            b.verify(&bad, "printer.pause", "bay-1", &h).unwrap_err(),
            Error::BadSignature
        );
        bad.token = "not base64 at all!".into();
        assert_eq!(
            b.verify(&bad, "printer.pause", "bay-1", &h).unwrap_err(),
            Error::BadSignature
        );
        bad.token = String::new();
        assert_eq!(
            b.verify(&bad, "printer.pause", "bay-1", &h).unwrap_err(),
            Error::BadSignature
        );
        // The genuine token still works after the failed attempts.
        b.verify(&t, "printer.pause", "bay-1", &h).unwrap();
    }

    #[test]
    fn token_moved_to_another_request_fails() {
        let (b, _) = broker();
        let t = granted(&b);
        b.register(request("req-2", vec![action("printer.cancel", "bay-1")]))
            .unwrap();
        let _ = b.grant("req-2").unwrap();
        let moved = ApprovalToken {
            request_id: "req-2".into(),
            ..t
        };
        assert_eq!(
            b.verify(&moved, "printer.cancel", "bay-1", &pause_hash("bay-1"))
                .unwrap_err(),
            Error::BadSignature
        );
    }

    #[test]
    fn token_from_another_broker_fails() {
        let (a, _) = broker();
        let (b, _) = broker();
        let t = granted(&a);
        b.register(request("req-1", vec![action("printer.pause", "bay-1")]))
            .unwrap();
        let _ = b.grant("req-1").unwrap();
        assert_eq!(
            b.verify(&t, "printer.pause", "bay-1", &pause_hash("bay-1"))
                .unwrap_err(),
            Error::BadSignature
        );
    }

    #[test]
    fn grant_twice_fails() {
        let (b, _) = broker();
        let _ = granted(&b);
        let err = b.grant("req-1").unwrap_err();
        assert!(
            matches!(err, Error::NotPending { state: "granted", .. }),
            "{err:?}"
        );
    }

    #[test]
    fn caller_mutation_after_register_cannot_widen_the_grant() {
        let (b, _) = broker();
        let mut req = request("req-1", vec![action("printer.pause", "bay-1")]);
        b.register(req.clone()).unwrap();
        req.actions.push(action("printer.start", "bay-2"));
        if let Some(a) = req.actions.first_mut() {
            a.target = "bay-3".into();
        }
        let t = b.grant("req-1").unwrap();
        let err = b
            .verify(&t, "printer.start", "bay-2", &pause_hash("bay-2"))
            .unwrap_err();
        assert!(matches!(err, Error::Mismatch { .. }), "{err:?}");
        let err = b
            .verify(&t, "printer.pause", "bay-3", &pause_hash("bay-3"))
            .unwrap_err();
        assert!(matches!(err, Error::Mismatch { .. }), "{err:?}");
        b.verify(&t, "printer.pause", "bay-1", &pause_hash("bay-1"))
            .unwrap();
    }

    #[test]
    fn each_action_verifies_once() {
        let (b, _) = broker();
        b.register(request(
            "req-1",
            vec![
                action("printer.upload", "bay-1"),
                action("printer.start", "bay-1"),
            ],
        ))
        .unwrap();
        let t = b.grant("req-1").unwrap();
        let h = pause_hash("bay-1");
        b.verify(&t, "printer.upload", "bay-1", &h).unwrap();
        assert!(matches!(
            b.verify(&t, "printer.upload", "bay-1", &h),
            Err(Error::Used { .. })
        ));
        b.verify(&t, "printer.start", "bay-1", &h).unwrap();
    }

    #[test]
    fn register_rejects_duplicates_and_malformed_actions() {
        let (b, _) = broker();
        b.register(request("req-1", vec![])).unwrap();
        assert!(matches!(
            b.register(request("req-1", vec![])),
            Err(Error::Duplicate { .. })
        ));
        let mut empty_target = action("printer.pause", "bay-1");
        empty_target.target.clear();
        let mut upper = action("printer.pause", "bay-1");
        upper.params_hash = upper.params_hash.to_uppercase();
        let mut short = action("printer.pause", "bay-1");
        short.params_hash.pop();
        let mut non_hex = action("printer.pause", "bay-1");
        non_hex.params_hash.replace_range(0..1, "g");
        for (i, bad) in [empty_target, upper, short, non_hex].into_iter().enumerate() {
            let err = b
                .register(request(
                    &format!("bad-{i}"),
                    vec![action("printer.pause", "bay-1"), bad],
                ))
                .unwrap_err();
            assert!(matches!(err, Error::MalformedAction { index: 1, .. }), "{err:?}");
        }
        assert_eq!(b.pending(), vec!["req-1".to_owned()]);
    }

    #[test]
    fn unknown_and_pending_requests_do_not_verify() {
        let (b, _) = broker();
        let t = ApprovalToken {
            request_id: "req-1".into(),
            token: "x".into(),
            expires_at: String::new(),
        };
        let h = pause_hash("bay-1");
        assert!(matches!(
            b.verify(&t, "printer.pause", "bay-1", &h),
            Err(Error::Unknown { .. })
        ));
        assert!(matches!(b.grant("req-1"), Err(Error::Unknown { .. })));
        b.register(request("req-1", vec![action("printer.pause", "bay-1")]))
            .unwrap();
        assert!(matches!(
            b.verify(&t, "printer.pause", "bay-1", &h),
            Err(Error::Unknown { .. })
        ));
    }

    #[test]
    fn debug_output_hides_the_token() {
        let (b, _) = broker();
        let t = granted(&b);
        let shown = format!("{t:?} {b:?}");
        assert!(!shown.contains(&t.token));
        assert!(shown.contains("req-1"));
    }

    #[test]
    fn token_is_base64url_hmac_sha256() {
        let (b, _) = broker();
        let t = granted(&b);
        assert_eq!(t.token.len(), 43);
        assert!(
            t.token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        );
    }

    #[test]
    fn a_local_click_cannot_be_registered_only_minted() {
        let (b, _) = broker();
        let mut req = request("req-1", vec![action("printer.start", "bay-1")]);
        req.origin = Some(StartOrigin::LocalClick);
        assert!(matches!(b.register(req.clone()), Err(Error::Origin { .. })));
        assert!(b.pending().is_empty());
        let t = b.mint(req, true).unwrap();
        let info = b.grant_info("req-1").unwrap();
        assert_eq!(info.origin, Some(StartOrigin::LocalClick));
        assert!(info.bed_confirmed);
        b.verify(&t, "printer.start", "bay-1", &pause_hash("bay-1"))
            .unwrap();
        // Same id again is a duplicate, whichever way it comes.
        let mut again = request("req-1", vec![]);
        again.origin = Some(StartOrigin::Queue);
        assert!(matches!(b.mint(again, false), Err(Error::Duplicate { .. })));
        // Card origins cannot be minted.
        for o in [
            None,
            Some(StartOrigin::Phone),
            Some(StartOrigin::Mcp),
            Some(StartOrigin::Pilot),
        ] {
            let mut r = request("req-9", vec![]);
            r.origin = o;
            assert!(matches!(b.mint(r, true), Err(Error::Origin { .. })), "{o:?}");
        }
    }

    #[test]
    fn the_watch_can_mint_a_pause_or_heaters_off_and_nothing_else() {
        let (b, _) = broker();
        let mut pause = request("w-1", vec![action("printer.pause", "bay-1")]);
        pause.origin = Some(StartOrigin::Watch);
        assert!(
            matches!(b.register(pause.clone()), Err(Error::Origin { .. })),
            "never a card"
        );
        let t = b.mint(pause, false).unwrap();
        b.verify(&t, "printer.pause", "bay-1", &pause_hash("bay-1"))
            .unwrap();
        let mut off = request("w-3", vec![action("printer.adjust", "bay-1")]);
        off.origin = Some(StartOrigin::Watch);
        assert!(
            b.mint(off, false).is_ok(),
            "heaters off after an unanswered pause"
        );
        for actions in [
            vec![action("printer.resume", "bay-1")],
            vec![action("printer.pause", "bay-1"), action("printer.start", "bay-1")],
            vec![action("printer.gcode", "bay-1")],
            vec![],
        ] {
            let mut r = request("w-2", actions);
            r.origin = Some(StartOrigin::Watch);
            assert!(matches!(b.mint(r, false), Err(Error::Origin { .. })));
        }
    }

    #[test]
    fn grant_info_reports_origin_and_the_bed_answer() {
        let (b, _) = broker();
        let mut req = request("req-1", vec![action("printer.start", "bay-1")]);
        req.origin = Some(StartOrigin::Phone);
        b.register(req).unwrap();
        assert_eq!(b.grant_info("req-1"), None, "pending has no grant");
        let _ = b.grant_with("req-1", true).unwrap();
        let info = b.grant_info("req-1").unwrap();
        assert_eq!(
            (info.origin, info.bed_confirmed, info.printer_id.as_deref()),
            (Some(StartOrigin::Phone), true, Some("bay-1"))
        );
        b.register(request("req-2", vec![action("printer.start", "bay-1")]))
            .unwrap();
        let _ = b.grant("req-2").unwrap();
        let info = b.grant_info("req-2").unwrap();
        assert_eq!((info.origin, info.bed_confirmed), (None, false));
        b.deny("req-2").unwrap();
        assert_eq!(b.grant_info("req-2"), None);
        assert_eq!(b.request("req-2").map(|r| r.id), Some("req-2".to_owned()));
    }

    #[test]
    fn iso_dates_match_to_iso_string() {
        for (ms, want) in [
            (0, "1970-01-01T00:00:00.000Z"),
            (1_790_000_000_123, "2026-09-21T14:13:20.123Z"),
            (951_782_400_000, "2000-02-29T00:00:00.000Z"),
            (1_709_164_800_000, "2024-02-29T00:00:00.000Z"),
            (4_102_444_799_999, "2099-12-31T23:59:59.999Z"),
        ] {
            assert_eq!(iso8601_ms(ms), want);
        }
    }

    #[test]
    fn check_runs_every_verify_check_without_using_the_token_up() {
        let (b, _) = broker();
        let t = granted(&b);
        let h = pause_hash("bay-1");
        b.check(&t, "printer.pause", "bay-1", &h).unwrap();
        b.check(&t, "printer.pause", "bay-1", &h).unwrap();
        assert!(matches!(
            b.check(&t, "printer.pause", "bay-2", &h),
            Err(Error::Mismatch { .. })
        ));
        b.verify(&t, "printer.pause", "bay-1", &h).unwrap();
        assert!(matches!(
            b.check(&t, "printer.pause", "bay-1", &h),
            Err(Error::Used { .. })
        ));
    }

    #[test]
    fn an_expired_grant_reports_nothing_and_an_expired_card_cannot_be_granted() {
        let (b, clock) = broker();
        let _ = granted(&b);
        assert!(b.grant_info("req-1").is_some());
        clock.advance(TOKEN_TTL);
        assert_eq!(
            b.grant_info("req-1"),
            None,
            "a used up token must not stand behind a start"
        );
        // The card in `request` expires five minutes after START_MS; the clock is there now.
        b.register(request("late", vec![action("printer.pause", "bay-1")]))
            .unwrap();
        assert!(matches!(b.grant("late"), Err(Error::Expired)));
        assert!(b.pending().is_empty(), "an expired card leaves the pending list");
        let mut bad = request("no-date", vec![action("printer.pause", "bay-1")]);
        bad.expires_at = "tomorrow".into();
        b.register(bad).unwrap();
        assert!(matches!(b.grant("no-date"), Err(Error::Expired)));
    }

    #[test]
    fn cap_expiry_brings_far_off_and_unreadable_expiry_to_the_cap() {
        let (b, _clock) = broker();
        let ttl = Duration::from_mins(30);
        let cap = iso8601_ms(START_MS + 30 * 60_000);
        let mut far = request("far", vec![action("printer.pause", "bay-1")]);
        far.expires_at = "2099-01-01T00:00:00.000Z".into();
        b.cap_expiry(&mut far, ttl);
        assert_eq!(far.expires_at, cap);
        let mut bad = request("bad", vec![action("printer.pause", "bay-1")]);
        bad.expires_at = "next year".into();
        b.cap_expiry(&mut bad, ttl);
        assert_eq!(bad.expires_at, cap);
        // A sooner expiry stays as the caller set it.
        let mut soon = request("soon", vec![action("printer.pause", "bay-1")]);
        let before = soon.expires_at.clone();
        b.cap_expiry(&mut soon, ttl);
        assert_eq!(soon.expires_at, before);
    }

    #[test]
    fn iso_dates_parse_back() {
        for ms in [0_u64, START_MS, 951_782_400_000, 4_102_444_799_999] {
            assert_eq!(parse_iso8601_ms(&iso8601_ms(ms)), Some(ms));
        }
        assert_eq!(parse_iso8601_ms("2026-10-01T12:00:00Z"), Some(1_790_856_000_000));
        for bad in [
            "",
            "2026-10-01",
            "2026-13-01T00:00:00.000Z",
            "2026-10-01T00:00:00.000",
            "2026-10-01T00:00:00.x00Z",
        ] {
            assert_eq!(parse_iso8601_ms(bad), None, "{bad}");
        }
    }
}
