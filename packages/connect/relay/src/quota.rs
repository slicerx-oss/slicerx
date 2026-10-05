// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Quotas. A signed-in account is metered as one; a connection without an account is metered with
//! everyone else on its IP address (an IPv6 /64), with lower limits.

use std::net::IpAddr;

use crate::month;

/// Limits for one meter (an account, or an address without an account).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TierLimits {
    pub live_connections: u32,
    pub frames_per_second: u32,
    pub bytes_per_minute: u64,
    /// Bytes sent and received through the relay in one UTC calendar month.
    pub bytes_per_month: u64,
}

/// Everything the relay enforces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Largest `body` in bytes.
    pub max_body: usize,
    /// Bodies kept for a route with no subscriber; older ones are dropped first.
    pub queue_per_route: usize,
    /// How long a queued body waits, in milliseconds.
    pub queue_ttl_ms: u64,
    /// Bytes queued across all routes. Past it, frames for routes without a subscriber are dropped.
    pub queue_bytes_total: usize,
    pub subscriptions_per_connection: usize,
    /// New connections a minute from one address.
    pub new_connections_per_minute: u32,
    /// Connections open at once, overall.
    pub max_connections: usize,
    /// Bytes waiting to be written to one connection before it counts as stuck and is closed.
    pub send_buffer: usize,
    /// Bytes waiting to be written over all connections. Past it, deliveries are dropped.
    pub send_buffer_total: usize,
    /// Bytes one meter (an account or an address) may have queued for routes without a subscriber.
    pub queue_bytes_per_meter: usize,
    /// Subscribers of one opaque route. A pairing route has one or two; account routes are bounded
    /// by the account's own connections.
    pub subscribers_per_route: usize,
    /// Connections open at once from one IPv6 /48, signed in or not, so a large prefix cannot open
    /// thousands of connections one /64 at a time.
    pub connections_per_v6_48: u32,
    /// Refused frames in a row after which a connection is closed.
    pub refusals_before_close: u32,
    pub account: TierLimits,
    pub anonymous: TierLimits,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_body: 1_500_000,
            queue_per_route: 64,
            queue_ttl_ms: 10 * 60 * 1000,
            queue_bytes_total: 256 << 20,
            subscriptions_per_connection: 256,
            new_connections_per_minute: 30,
            max_connections: 20_000,
            send_buffer: 8 << 20,
            send_buffer_total: 512 << 20,
            queue_bytes_per_meter: 16 << 20,
            subscribers_per_route: 4,
            connections_per_v6_48: 32,
            refusals_before_close: 64,
            account: TierLimits {
                live_connections: 8,
                frames_per_second: 50,
                bytes_per_minute: 20_000_000,
                bytes_per_month: 5_000_000_000,
            },
            anonymous: TierLimits {
                live_connections: 4,
                frames_per_second: 20,
                bytes_per_minute: 5_000_000,
                bytes_per_month: 1_000_000_000,
            },
        }
    }
}

/// Who pays for a connection's traffic.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum MeterKey {
    Account(String),
    Address(IpAddr),
}

impl MeterKey {
    /// IPv4 addresses as they are, IPv6 by their /64 (one household or one phone's prefix).
    pub fn address(ip: IpAddr) -> Self {
        Self::Address(address_key(ip))
    }
}

/// The /48 an IPv6 address belongs to; `None` for IPv4 (metered per address already).
pub fn wide_key(ip: IpAddr) -> Option<IpAddr> {
    match address_key(ip) {
        IpAddr::V4(_) => None,
        IpAddr::V6(v6) => Some(IpAddr::V6((u128::from(v6) & !((1u128 << 80) - 1)).into())),
    }
}

pub fn address_key(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6((u128::from(v6) & !((1u128 << 64) - 1)).into()),
        },
    }
}

/// A token bucket: `cap` tokens, refilled at `cap` per `per_ms`.
#[derive(Debug, Clone, Copy)]
pub struct Bucket {
    tokens: f64,
    at_ms: u64,
}

impl Bucket {
    #[allow(clippy::cast_precision_loss)]
    pub fn full(cap: u64, now_ms: u64) -> Self {
        Self {
            tokens: cap as f64,
            at_ms: now_ms,
        }
    }

    #[allow(clippy::cast_precision_loss)]
    fn refill(&mut self, cap: u64, per_ms: u64, now_ms: u64) {
        let cap = cap as f64;
        let dt = now_ms.saturating_sub(self.at_ms) as f64;
        self.tokens = (self.tokens + dt * cap / per_ms as f64).min(cap);
        self.at_ms = now_ms.max(self.at_ms);
    }

    /// Takes `n` tokens if there are that many.
    #[allow(clippy::cast_precision_loss)]
    pub fn take(&mut self, n: u64, cap: u64, per_ms: u64, now_ms: u64) -> bool {
        self.refill(cap, per_ms, now_ms);
        let n = n as f64;
        if self.tokens >= n {
            self.tokens -= n;
            true
        } else {
            false
        }
    }

    /// True once the bucket has refilled completely and can be forgotten.
    #[allow(clippy::cast_precision_loss)]
    pub fn idle(&mut self, cap: u64, per_ms: u64, now_ms: u64) -> bool {
        self.refill(cap, per_ms, now_ms);
        self.tokens >= cap as f64
    }
}

/// Which limit refused a frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Second,
    Minute,
    Month,
    Connections,
}

impl Refusal {
    pub fn scope(self) -> &'static str {
        match self {
            Self::Second => "second",
            Self::Minute => "minute",
            Self::Month => "month",
            Self::Connections => "connections",
        }
    }
}

/// Counters for one account or address.
#[derive(Debug, Clone)]
pub struct Meter {
    pub live: u32,
    frames: Bucket,
    bytes: Bucket,
    month: u32,
    pub month_used: u64,
}

impl Meter {
    pub fn new(t: &TierLimits, now_ms: u64) -> Self {
        Self {
            live: 0,
            frames: Bucket::full(u64::from(t.frames_per_second), now_ms),
            bytes: Bucket::full(t.bytes_per_minute, now_ms),
            month: month::key(now_ms),
            month_used: 0,
        }
    }

    fn roll(&mut self, now_ms: u64) {
        let m = month::key(now_ms);
        if m != self.month {
            self.month = m;
            self.month_used = 0;
        }
    }

    /// Bytes used this month, after a month change resets the count.
    pub fn used(&mut self, now_ms: u64) -> u64 {
        self.roll(now_ms);
        self.month_used
    }

    /// Charges one frame of `len` bytes a connection sends.
    pub fn charge_send(&mut self, t: &TierLimits, len: u64, now_ms: u64) -> Result<(), Refusal> {
        self.charge_frame(t, now_ms)?;
        self.charge_bytes(t, len, len, now_ms)
    }

    /// Charges one inbound frame of any kind against the per-second frame rate.
    pub fn charge_frame(&mut self, t: &TierLimits, now_ms: u64) -> Result<(), Refusal> {
        if self.frames.take(1, u64::from(t.frames_per_second), 1000, now_ms) {
            Ok(())
        } else {
            Err(Refusal::Second)
        }
    }

    /// Charges a send of `len` bytes that the relay delivers as `rate` bytes in all (one copy per
    /// subscriber): the copies count against the per-minute rate, the body once against the month.
    pub fn charge_bytes(&mut self, t: &TierLimits, len: u64, rate: u64, now_ms: u64) -> Result<(), Refusal> {
        self.roll(now_ms);
        if self.month_used.saturating_add(len) > t.bytes_per_month {
            return Err(Refusal::Month);
        }
        if !self.bytes.take(rate, t.bytes_per_minute, 60_000, now_ms) {
            return Err(Refusal::Minute);
        }
        self.month_used += len;
        Ok(())
    }

    /// Charges `len` bytes delivered to a connection. Only the monthly total applies: a receiver
    /// does not choose what it is sent, and the sender already paid the rate limits.
    pub fn charge_receive(&mut self, t: &TierLimits, len: u64, now_ms: u64) -> Result<(), Refusal> {
        self.roll(now_ms);
        if self.month_used.saturating_add(len) > t.bytes_per_month {
            return Err(Refusal::Month);
        }
        self.month_used += len;
        Ok(())
    }

    /// Nothing open and nothing used this month: safe to forget.
    pub fn forgettable(&mut self, now_ms: u64) -> bool {
        self.live == 0 && self.used(now_ms) == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rates_refill_and_the_month_resets() {
        let t = TierLimits {
            live_connections: 1,
            frames_per_second: 2,
            bytes_per_minute: 600,
            bytes_per_month: 1000,
        };
        let start = 1_793_491_200_000 - 120_000; // two minutes before November 2026
        let mut m = Meter::new(&t, start);
        assert_eq!(m.charge_send(&t, 100, start), Ok(()));
        assert_eq!(m.charge_send(&t, 100, start), Ok(()));
        assert_eq!(m.charge_send(&t, 100, start), Err(Refusal::Second));
        assert_eq!(m.charge_send(&t, 400, start + 1000), Ok(()));
        assert_eq!(m.charge_send(&t, 100, start + 1000), Err(Refusal::Minute));
        assert_eq!(m.charge_send(&t, 100, start + 60_000), Ok(()));
        assert_eq!(m.charge_receive(&t, 300, start + 60_000), Ok(()));
        assert_eq!(m.used(start + 60_000), 1000);
        assert_eq!(m.charge_send(&t, 1, start + 61_000), Err(Refusal::Month));
        assert_eq!(m.charge_receive(&t, 1, start + 61_000), Err(Refusal::Month));
        assert_eq!(m.charge_send(&t, 100, start + 120_000), Ok(()));
        assert_eq!(m.used(start + 120_000), 100);
    }

    #[test]
    fn ipv6_prefixes_are_counted_per_48_too() {
        let a: IpAddr = "2001:db8:1:2::1".parse().unwrap_or(IpAddr::from([0u8; 4]));
        let b: IpAddr = "2001:db8:1:ff00::1".parse().unwrap_or(IpAddr::from([0u8; 4]));
        let c: IpAddr = "2001:db8:2::1".parse().unwrap_or(IpAddr::from([0u8; 4]));
        assert_eq!(wide_key(a), wide_key(b));
        assert_ne!(wide_key(a), wide_key(c));
        assert_eq!(wide_key(IpAddr::from([192, 0, 2, 7])), None);
    }

    #[test]
    fn ipv6_addresses_share_a_meter_per_64() {
        let a: IpAddr = "2001:db8:1:2:aaaa::1".parse().unwrap_or(IpAddr::from([0u8; 4]));
        let b: IpAddr = "2001:db8:1:2:bbbb::9".parse().unwrap_or(IpAddr::from([0u8; 4]));
        let c: IpAddr = "2001:db8:1:3::1".parse().unwrap_or(IpAddr::from([0u8; 4]));
        assert_eq!(MeterKey::address(a), MeterKey::address(b));
        assert_ne!(MeterKey::address(a), MeterKey::address(c));
        let mapped: IpAddr = "::ffff:192.0.2.7".parse().unwrap_or(IpAddr::from([0u8; 4]));
        assert_eq!(
            MeterKey::address(mapped),
            MeterKey::Address(IpAddr::from([192, 0, 2, 7]))
        );
    }
}
