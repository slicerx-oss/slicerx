// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Pairing with sx-link by code, over `CPace`. The hub holds three codes (app, agent, watch) and a
//! client does not say which it has, so the hub answers with one message per code and the client
//! confirms each; only the matching one verifies.
//!
//! ```text
//!   client -> hub  hello   { nonce }                                  hub signs it
//!   client -> hub  pair    { pake: Ya }
//!   hub -> client          { pake: { app: Yb, agent: Yb, watch: Yb } }
//!   client -> hub  pair    { confirm: { app: t, agent: t, watch: t } } t = HMAC(ISK, client label)
//!   hub -> client          { paired, role, confirm: HMAC(ISK, hub label) }
//!
//!   G   = generator(code, CI = lv(PAIR_V2, hubKey, port), sid = lv(clientNonce, hubNonce))
//!   CI binds the protocol version and the hub's identity key. The client has no key (only the
//!   code names it), so its side is named in the associated data, as the draft allows.
//!   ISK = SHA-512(lv(DSI_ISK, sid, K) || lv(Ya, "client") || lv(Yb, role))
//! ```
use curve25519_dalek::scalar::Scalar;
use hmac::{Hmac, KeyInit as _, Mac as _};
use sha2::Sha256;
use zeroize::Zeroize as _;

use crate::{generator, isk_ir, lv_cat, scalar, secret, share};

pub const PAIR_V2: &[u8] = b"sx-link pair v2";
/// The codes a hub holds, in the order of its answer.
pub const ROLES: [&str; 3] = ["app", "agent", "watch"];
const CLIENT_AD: &[u8] = b"client";

/// What one run is bound to: the hub's key and port from its signed hello, and both nonces.
pub struct Context<'a> {
    pub hub_key: &'a [u8],
    pub port: u16,
    pub client_nonce: &'a [u8],
    pub hub_nonce: &'a [u8],
}

impl Context<'_> {
    fn channel(&self) -> Vec<u8> {
        lv_cat(&[PAIR_V2, self.hub_key, &self.port.to_be_bytes()])
    }

    fn sid(&self) -> Vec<u8> {
        lv_cat(&[self.client_nonce, self.hub_nonce])
    }
}

/// The code as the hub normalizes it: letters and digits, upper case.
pub fn normalize(code: &str) -> Vec<u8> {
    code.bytes()
        .filter(u8::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

fn tag(isk: &[u8; 64], side: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    if let Ok(mut m) = Hmac::<Sha256>::new_from_slice(isk) {
        m.update(format!("sx-link pair v2 {side}").as_bytes());
        out.copy_from_slice(&m.finalize().into_bytes());
    }
    out
}

fn tag_ok(isk: &[u8; 64], side: &str, t: &[u8]) -> bool {
    Hmac::<Sha256>::new_from_slice(isk).is_ok_and(|mut m| {
        m.update(format!("sx-link pair v2 {side}").as_bytes());
        m.verify_slice(t).is_ok()
    })
}

/// The hub's side of one run.
pub struct Answer {
    /// `(role, Yb)` for each code the hub holds.
    pub messages: Vec<(&'static str, [u8; 32])>,
    isks: Vec<(&'static str, [u8; 64])>,
}

impl Answer {
    /// Answers the client's `ya` for each `(role, code)`. `random` gives 32 fresh bytes per call.
    /// `None` when `ya` is not a valid message.
    pub fn new(
        codes: &[(&'static str, &str)],
        ctx: &Context<'_>,
        ya: &[u8],
        mut random: impl FnMut() -> [u8; 32],
    ) -> Option<Self> {
        let (ci, sid) = (ctx.channel(), ctx.sid());
        let mut messages = Vec::new();
        let mut isks = Vec::new();
        for (role, code) in codes {
            let mut y = scalar(random());
            let yb = share(&y, &generator(&normalize(code), &ci, &sid));
            let k = secret(&y, ya);
            y.zeroize();
            let mut k = k?;
            isks.push((*role, isk_ir(&sid, &k, ya, CLIENT_AD, &yb, role.as_bytes())));
            k.zeroize();
            messages.push((*role, yb));
        }
        Some(Self { messages, isks })
    }

    /// The role whose client tag verifies, with the hub's confirm; `None` for a wrong code.
    /// Every tag is checked, in constant time each.
    pub fn check(&self, tags: &[(&str, Vec<u8>)]) -> Option<(&'static str, [u8; 32])> {
        let mut found = None;
        for (role, isk) in &self.isks {
            let ok = tags.iter().any(|(r, t)| r == role && tag_ok(isk, "client", t));
            if ok && found.is_none() {
                found = Some((*role, tag(isk, "hub")));
            }
        }
        found
    }
}

impl Drop for Answer {
    fn drop(&mut self) {
        for (_, isk) in &mut self.isks {
            isk.zeroize();
        }
    }
}

/// The client's side of one run.
pub struct Start {
    pub ya: [u8; 32],
    y: Scalar,
    sid: Vec<u8>,
    isks: Vec<[u8; 64]>,
}

impl Start {
    /// `random` is 32 fresh random bytes.
    pub fn new(code: &str, ctx: &Context<'_>, random: [u8; 32]) -> Self {
        let y = scalar(random);
        let sid = ctx.sid();
        let ya = share(&y, &generator(&normalize(code), &ctx.channel(), &sid));
        Self {
            ya,
            y,
            sid,
            isks: Vec::new(),
        }
    }

    /// Takes the hub's `(role, Yb)` messages and returns the confirm tags to send, one per role.
    /// `None` when a message is missing or invalid.
    pub fn respond(&mut self, messages: &[(&str, Vec<u8>)]) -> Option<Vec<(&'static str, [u8; 32])>> {
        for isk in &mut self.isks {
            isk.zeroize();
        }
        self.isks.clear();
        let mut out = Vec::new();
        for role in ROLES {
            let yb = messages.iter().find(|(r, _)| *r == role).map(|(_, m)| m)?;
            let mut k = secret(&self.y, yb)?;
            let isk = isk_ir(&self.sid, &k, &self.ya, CLIENT_AD, yb, role.as_bytes());
            k.zeroize();
            out.push((role, tag(&isk, "client")));
            self.isks.push(isk);
        }
        Some(out)
    }

    /// Whether the hub's confirm proves it ran the exchange with the same code.
    pub fn hub_confirmed(&self, t: &[u8]) -> bool {
        self.isks.iter().any(|isk| tag_ok(isk, "hub", t))
    }
}

impl Drop for Start {
    fn drop(&mut self) {
        self.y.zeroize();
        for isk in &mut self.isks {
            isk.zeroize();
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::format_collect)]
    use super::*;
    use serde_json::Value;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn to_hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn arr(s: &str) -> [u8; 32] {
        hex(s).try_into().unwrap()
    }

    /// The vectors the TypeScript client and hub produced: this hub answers the TypeScript client,
    /// and this client answers the TypeScript hub, byte for byte.
    #[test]
    fn interoperates_with_the_typescript_side() {
        let v: Value = serde_json::from_str(include_str!("../vectors.json")).unwrap();
        let s = |k: &str| v[k].as_str().unwrap().to_owned();
        let (hub_key, cn, hn) = (hex(&s("hubKey")), hex(&s("clientNonce")), hex(&s("hubNonce")));
        let ctx = Context {
            hub_key: &hub_key,
            port: u16::try_from(v["port"].as_u64().unwrap()).unwrap(),
            client_nonce: &cn,
            hub_nonce: &hn,
        };
        let codes: Vec<(&'static str, String)> = ROLES
            .iter()
            .map(|r| (*r, v["codes"][*r].as_str().unwrap().to_owned()))
            .collect();
        let codes: Vec<(&'static str, &str)> = codes.iter().map(|(r, c)| (*r, c.as_str())).collect();

        let mut client = Start::new(&s("clientCode"), &ctx, arr(&s("clientRandom")));
        assert_eq!(to_hex(&client.ya), s("ya"));

        let mut randoms = v["hubRandom"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| arr(x.as_str().unwrap()));
        let hub = Answer::new(&codes, &ctx, &hex(&s("ya")), || randoms.next().unwrap()).unwrap();
        for (role, yb) in &hub.messages {
            assert_eq!(to_hex(yb), v["yb"][*role].as_str().unwrap(), "{role}");
        }

        let from_ts: Vec<(&str, Vec<u8>)> = ROLES
            .iter()
            .map(|r| (*r, hex(v["yb"][*r].as_str().unwrap())))
            .collect();
        let tags = client.respond(&from_ts).unwrap();
        for (role, t) in &tags {
            assert_eq!(to_hex(t), v["clientTags"][*role].as_str().unwrap(), "{role}");
        }
        let ts_tags: Vec<(&str, Vec<u8>)> = ROLES
            .iter()
            .map(|r| (*r, hex(v["clientTags"][*r].as_str().unwrap())))
            .collect();
        let (role, confirm) = hub.check(&ts_tags).unwrap();
        assert_eq!(role, s("role"));
        assert_eq!(to_hex(&confirm), s("hubConfirm"));
        assert!(client.hub_confirmed(&hex(&s("hubConfirm"))));
    }

    #[test]
    fn a_wrong_code_verifies_nothing() {
        let ctx = Context {
            hub_key: &[1; 32],
            port: 47615,
            client_nonce: &[2; 32],
            hub_nonce: &[3; 32],
        };
        let mut client = Start::new("WXYZ-2345", &ctx, [4; 32]);
        let mut n = 5u8;
        let hub = Answer::new(
            &[
                ("app", "ABCD-EFGH"),
                ("agent", "JKMN-PQRS"),
                ("watch", "TUVW-XYZ2"),
            ],
            &ctx,
            &client.ya,
            || {
                n += 1;
                [n; 32]
            },
        )
        .unwrap();
        let msgs: Vec<(&str, Vec<u8>)> = hub.messages.iter().map(|(r, m)| (*r, m.to_vec())).collect();
        let tags: Vec<(&str, Vec<u8>)> = client
            .respond(&msgs)
            .unwrap()
            .into_iter()
            .map(|(r, t)| (r, t.to_vec()))
            .collect();
        assert!(hub.check(&tags).is_none());
        assert!(!client.hub_confirmed(&[0; 32]));
        // An invalid client message gets no answer.
        assert!(Answer::new(&[("app", "ABCD-EFGH")], &ctx, &[0; 32], || [9; 32]).is_none());
    }
}
