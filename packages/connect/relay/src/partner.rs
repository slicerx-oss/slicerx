// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Partner routes: a partner app's sealed byte stream between the hub (for the partner's desktop app)
//! and the partner's own paired phone. The hub opens a pair of `pr:` routes (`up` from the phone,
//! `down` to it) on its signed-in relay connection, and the relay caps them: routes open at once per
//! account, bytes per route per UTC day, bytes per account per UTC day, and an idle timeout. The
//! relay counts sizes and times only. It never reads a body, here or anywhere else.

use std::collections::HashMap;

use crate::quota::PartnerLimits;
use crate::route;

const DAY_MS: u64 = 86_400_000;

fn day(now_ms: u64) -> u64 {
    now_ms / DAY_MS
}

/// Why a partner route closed, as `partner.closed` says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Closed {
    /// The connection that opened it closed it.
    Closed,
    /// Nothing crossed it for the idle timeout.
    Idle,
    /// It carried its bytes for the day.
    RouteCap,
    /// The account's partner routes carried their bytes for the day.
    AccountCap,
    /// The connection that opened it went away.
    OwnerGone,
    /// The opening connection's account session ran out.
    SignedOut,
}

impl Closed {
    pub fn reason(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Idle => "idle",
            Self::RouteCap => "route_cap",
            Self::AccountCap => "account_cap",
            Self::OwnerGone => "owner_gone",
            Self::SignedOut => "signed_out",
        }
    }
}

/// Why `partner.open` was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenError {
    /// Partner routes belong to an account: the connection must be signed in.
    NotSignedIn,
    /// `up` and `down` must be two different `pr:` routes.
    BadRoute,
    /// One of the routes is open already.
    InUse,
    /// The account has `routes_per_account` open.
    TooMany,
    /// The account's partner traffic for today is used up.
    AccountCap,
}

/// What a frame on a partner route runs into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Charge {
    /// No open partner route by that name.
    NotOpen,
    /// The frame closes this route (idle too long, or its day's bytes are used).
    CloseRoute(Closed),
    /// The frame would pass the account's bytes for the day: all its partner routes close.
    CloseAccount,
}

/// One open partner route. Sizes and times only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    /// The relay connection that opened it.
    pub owner: u64,
    pub account: String,
    pub up: String,
    pub down: String,
    pub opened_ms: u64,
    pub last_ms: u64,
    day: u64,
    /// Bytes today (UTC), both directions.
    pub today: u64,
    /// Bytes since it opened.
    pub total: u64,
}

/// Every open partner route, and each account's partner bytes today.
#[derive(Debug, Default)]
pub struct Partners {
    /// By `up` route.
    routes: HashMap<String, Route>,
    /// `up` and `down` to `up`.
    by_route: HashMap<String, String>,
    /// Account to (UTC day, bytes that day). Kept after its routes close, so closing and reopening
    /// never resets the account's day.
    account_day: HashMap<String, (u64, u64)>,
    /// Bytes carried by partner routes since the relay started.
    pub bytes: u64,
}

impl Partners {
    pub fn len(&self) -> usize {
        self.routes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.routes.is_empty()
    }

    pub fn is_open(&self, route: &str) -> bool {
        self.by_route.contains_key(route)
    }

    pub fn get(&self, route: &str) -> Option<&Route> {
        self.routes.get(self.by_route.get(route)?)
    }

    /// Open routes of one account.
    pub fn count(&self, account: &str) -> usize {
        self.routes.values().filter(|r| r.account == account).count()
    }

    /// `up` of every route `owner` opened.
    pub fn owned_by(&self, owner: u64) -> Vec<String> {
        self.routes
            .values()
            .filter(|r| r.owner == owner)
            .map(|r| r.up.clone())
            .collect()
    }

    /// `up` of every route of `account`.
    pub fn of_account(&self, account: &str) -> Vec<String> {
        self.routes
            .values()
            .filter(|r| r.account == account)
            .map(|r| r.up.clone())
            .collect()
    }

    /// The account's partner bytes today.
    pub fn account_used(&self, account: &str, now_ms: u64) -> u64 {
        match self.account_day.get(account) {
            Some((d, n)) if *d == day(now_ms) => *n,
            _ => 0,
        }
    }

    /// Opens `up` and `down` for `owner`, signed in as `account`.
    pub fn open(
        &mut self,
        lim: &PartnerLimits,
        owner: u64,
        account: Option<&str>,
        up: &str,
        down: &str,
        now_ms: u64,
    ) -> Result<(), OpenError> {
        let Some(account) = account else {
            return Err(OpenError::NotSignedIn);
        };
        if up == down || !route::is_partner(up) || !route::is_partner(down) {
            return Err(OpenError::BadRoute);
        }
        if self.is_open(up) || self.is_open(down) {
            return Err(OpenError::InUse);
        }
        if self.count(account) >= usize::try_from(lim.routes_per_account).unwrap_or(usize::MAX) {
            return Err(OpenError::TooMany);
        }
        if self.account_used(account, now_ms) >= lim.bytes_per_account_per_day {
            return Err(OpenError::AccountCap);
        }
        self.by_route.insert(up.to_owned(), up.to_owned());
        self.by_route.insert(down.to_owned(), up.to_owned());
        self.routes.insert(
            up.to_owned(),
            Route {
                owner,
                account: account.to_owned(),
                up: up.to_owned(),
                down: down.to_owned(),
                opened_ms: now_ms,
                last_ms: now_ms,
                day: day(now_ms),
                today: 0,
                total: 0,
            },
        );
        Ok(())
    }

    /// Removes the route `route` (its `up` or `down`) belongs to.
    pub fn close(&mut self, route: &str) -> Option<Route> {
        let up = self.by_route.get(route)?.clone();
        let r = self.routes.remove(&up)?;
        self.by_route.remove(&r.up);
        self.by_route.remove(&r.down);
        Some(r)
    }

    /// Whether a frame of `len` bytes may cross `route` now. Changes nothing: [`Self::commit`]
    /// counts it once every other limit passed too.
    pub fn check(&self, lim: &PartnerLimits, route: &str, len: u64, now_ms: u64) -> Result<(), Charge> {
        let Some(r) = self.get(route) else {
            return Err(Charge::NotOpen);
        };
        if now_ms.saturating_sub(r.last_ms) >= lim.idle_ms {
            return Err(Charge::CloseRoute(Closed::Idle));
        }
        let today = if r.day == day(now_ms) { r.today } else { 0 };
        if today.saturating_add(len) > lim.bytes_per_route_per_day {
            return Err(Charge::CloseRoute(Closed::RouteCap));
        }
        if self.account_used(&r.account, now_ms).saturating_add(len) > lim.bytes_per_account_per_day {
            return Err(Charge::CloseAccount);
        }
        Ok(())
    }

    /// Counts a frame of `len` bytes that [`Self::check`] passed.
    pub fn commit(&mut self, route: &str, len: u64, now_ms: u64) {
        let Some(up) = self.by_route.get(route).cloned() else {
            return;
        };
        let Some(r) = self.routes.get_mut(&up) else {
            return;
        };
        let d = day(now_ms);
        if r.day != d {
            r.day = d;
            r.today = 0;
        }
        r.today = r.today.saturating_add(len);
        r.total = r.total.saturating_add(len);
        r.last_ms = now_ms;
        let account = r.account.clone();
        let e = self.account_day.entry(account).or_insert((d, 0));
        if e.0 != d {
            *e = (d, 0);
        }
        e.1 = e.1.saturating_add(len);
        self.bytes = self.bytes.saturating_add(len);
    }

    /// Marks the account's partner bytes for today as used up, after a frame ran past the cap: its
    /// routes close, and no new one opens until the next UTC day.
    pub fn exhaust(&mut self, lim: &PartnerLimits, account: &str, now_ms: u64) {
        self.account_day
            .insert(account.to_owned(), (day(now_ms), lim.bytes_per_account_per_day));
    }

    /// `up` of every route idle for the timeout.
    pub fn idle(&self, lim: &PartnerLimits, now_ms: u64) -> Vec<String> {
        self.routes
            .values()
            .filter(|r| now_ms.saturating_sub(r.last_ms) >= lim.idle_ms)
            .map(|r| r.up.clone())
            .collect()
    }

    /// Forgets account counts from earlier days.
    pub fn sweep_days(&mut self, now_ms: u64) {
        let d = day(now_ms);
        self.account_day.retain(|_, (at, _)| *at == d);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_790_899_200_000 + 3_600_000; // 2026-10-02T01:00:00Z

    fn r(c: char) -> String {
        format!("pr:{}", c.to_string().repeat(43))
    }

    fn lim() -> PartnerLimits {
        PartnerLimits {
            routes_per_account: 2,
            bytes_per_route_per_day: 1000,
            bytes_per_account_per_day: 1500,
            idle_ms: 60_000,
        }
    }

    #[test]
    fn only_a_signed_in_connection_opens_two_new_partner_routes() {
        let mut p = Partners::default();
        let l = lim();
        assert_eq!(
            p.open(&l, 1, None, &r('a'), &r('b'), NOW),
            Err(OpenError::NotSignedIn)
        );
        assert_eq!(
            p.open(&l, 1, Some("acct"), &r('a'), &r('a'), NOW),
            Err(OpenError::BadRoute)
        );
        let plain = "A".repeat(43);
        assert_eq!(
            p.open(&l, 1, Some("acct"), &plain, &r('b'), NOW),
            Err(OpenError::BadRoute)
        );
        assert_eq!(p.open(&l, 1, Some("acct"), &r('a'), &r('b'), NOW), Ok(()));
        assert_eq!(
            p.open(&l, 2, Some("other"), &r('b'), &r('c'), NOW),
            Err(OpenError::InUse)
        );
        assert!(p.is_open(&r('a')) && p.is_open(&r('b')));
        assert_eq!(p.get(&r('b')).map(|x| x.up.clone()), Some(r('a')));
    }

    #[test]
    fn caps_routes_per_account_and_bytes_per_route_and_account_per_day() {
        let mut p = Partners::default();
        let l = lim();
        p.open(&l, 1, Some("acct"), &r('a'), &r('b'), NOW).unwrap();
        p.open(&l, 1, Some("acct"), &r('c'), &r('d'), NOW).unwrap();
        assert_eq!(
            p.open(&l, 1, Some("acct"), &r('e'), &r('f'), NOW),
            Err(OpenError::TooMany)
        );
        // Another account has its own count.
        assert_eq!(p.open(&l, 2, Some("other"), &r('e'), &r('f'), NOW), Ok(()));

        // Both directions count against the route's day.
        assert_eq!(p.check(&l, &r('a'), 600, NOW), Ok(()));
        p.commit(&r('a'), 600, NOW);
        assert_eq!(p.check(&l, &r('b'), 400, NOW), Ok(()));
        p.commit(&r('b'), 400, NOW);
        assert_eq!(p.get(&r('a')).map(|x| x.today), Some(1000));
        assert_eq!(
            p.check(&l, &r('a'), 1, NOW),
            Err(Charge::CloseRoute(Closed::RouteCap))
        );

        // The account's other route runs into the account's day (1000 used of 1500).
        assert_eq!(p.check(&l, &r('c'), 500, NOW), Ok(()));
        assert_eq!(p.check(&l, &r('c'), 501, NOW), Err(Charge::CloseAccount));
        p.commit(&r('c'), 400, NOW);
        assert_eq!(p.account_used("acct", NOW), 1400);
        assert_eq!(p.account_used("other", NOW), 0);
        // A frame past the account's day uses the day up, though it never crossed.
        assert_eq!(p.check(&l, &r('c'), 101, NOW), Err(Charge::CloseAccount));
        p.exhaust(&l, "acct", NOW);
        assert_eq!(p.account_used("acct", NOW), 1500);

        // Closing and reopening does not reset the account's day.
        p.close(&r('a'));
        p.close(&r('d'));
        assert_eq!(p.count("acct"), 0);
        assert_eq!(
            p.open(&l, 1, Some("acct"), &r('g'), &r('h'), NOW),
            Err(OpenError::AccountCap)
        );

        // The next UTC day starts both counts again.
        let tomorrow = NOW + DAY_MS;
        p.sweep_days(tomorrow);
        assert_eq!(p.account_used("acct", tomorrow), 0);
        assert_eq!(p.open(&l, 1, Some("acct"), &r('g'), &r('h'), tomorrow), Ok(()));
        assert_eq!(p.bytes, 1400);
    }

    #[test]
    fn a_route_that_carries_nothing_for_the_idle_timeout_is_dropped() {
        let mut p = Partners::default();
        let l = lim();
        p.open(&l, 1, Some("acct"), &r('a'), &r('b'), NOW).unwrap();
        p.open(&l, 1, Some("acct"), &r('c'), &r('d'), NOW).unwrap();
        p.commit(&r('c'), 10, NOW + 50_000);
        assert!(p.idle(&l, NOW + 59_999).is_empty());
        assert_eq!(p.idle(&l, NOW + 60_000), vec![r('a')]);
        assert_eq!(
            p.check(&l, &r('b'), 1, NOW + 60_000),
            Err(Charge::CloseRoute(Closed::Idle))
        );
        assert_eq!(p.check(&l, &r('d'), 1, NOW + 60_000), Ok(()));
    }

    #[test]
    fn closing_takes_both_routes_and_nothing_crosses_a_closed_route() {
        let mut p = Partners::default();
        let l = lim();
        p.open(&l, 7, Some("acct"), &r('a'), &r('b'), NOW).unwrap();
        assert_eq!(p.owned_by(7), vec![r('a')]);
        assert_eq!(p.of_account("acct"), vec![r('a')]);
        let gone = p.close(&r('b')).unwrap();
        assert_eq!(
            (gone.up.as_str(), gone.down.as_str()),
            (r('a').as_str(), r('b').as_str())
        );
        assert!(!p.is_open(&r('a')) && !p.is_open(&r('b')));
        assert_eq!(p.check(&l, &r('a'), 1, NOW), Err(Charge::NotOpen));
        assert!(p.close(&r('a')).is_none());
        assert!(p.is_empty());
    }
}
