// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! HTTP digest authentication (RFC 7616, MD5, `qop=auth`), which PrusaLink accepts in place of an
//! API key.
use std::collections::BTreeMap;
use std::sync::{Mutex, PoisonError};

use md5::{Digest, Md5};

use crate::types::hex;

/// What the server asked for in `WWW-Authenticate: Digest ...`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Challenge {
    realm: String,
    nonce: String,
    opaque: Option<String>,
    /// True when the server offered `qop=auth`.
    qop_auth: bool,
    /// The rest as the server sent them, for the connection log.
    qop: Option<String>,
    algorithm: Option<String>,
    stale: Option<String>,
}

impl Challenge {
    /// Parses a `WWW-Authenticate` value. `None` for other schemes and for algorithms other than MD5.
    pub(crate) fn parse(header: &str) -> Option<Challenge> {
        let rest = header
            .trim()
            .strip_prefix("Digest ")
            .or_else(|| header.trim().strip_prefix("digest "))?;
        let mut kv: BTreeMap<String, String> = BTreeMap::new();
        for part in split_params(rest) {
            if let Some((k, v)) = part.split_once('=') {
                kv.insert(
                    k.trim().to_ascii_lowercase(),
                    v.trim().trim_matches('"').to_owned(),
                );
            }
        }
        if kv
            .get("algorithm")
            .is_some_and(|a| !a.eq_ignore_ascii_case("MD5"))
        {
            return None;
        }
        Some(Challenge {
            realm: kv.get("realm")?.clone(),
            nonce: kv.get("nonce")?.clone(),
            opaque: kv.get("opaque").cloned(),
            qop_auth: kv
                .get("qop")
                .is_some_and(|q| q.split(',').any(|o| o.trim() == "auth")),
            qop: kv.get("qop").cloned(),
            algorithm: kv.get("algorithm").cloned(),
            stale: kv.get("stale").cloned(),
        })
    }

    /// The challenge in words for the connection log. Holds no secret: the server sends all of it.
    pub(crate) fn describe(&self) -> String {
        let or_none = |v: &Option<String>| v.clone().unwrap_or_else(|| "none".to_owned());
        format!(
            "realm \"{}\", nonce \"{}\", qop {}, algorithm {}, opaque {}, stale {}",
            self.realm,
            self.nonce,
            or_none(&self.qop),
            or_none(&self.algorithm),
            or_none(&self.opaque),
            or_none(&self.stale),
        )
    }
}

/// Splits on commas that are outside double quotes.
fn split_params(s: &str) -> Vec<&str> {
    let (mut out, mut start, mut quoted) = (Vec::new(), 0, false);
    for (i, c) in s.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ',' if !quoted => {
                out.push(s.get(start..i).unwrap_or(""));
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(s.get(start..).unwrap_or(""));
    out
}

fn md5_hex(s: &str) -> String {
    hex(&Md5::digest(s.as_bytes()))
}

/// The `Authorization` header value for one request, in ffmpeg's order: `response` right after
/// `uri`. Without `qop` every value is quoted and `algorithm` is left out (MD5 is what its absence
/// means, RFC 7616 3.4): live555's RTSP server (Bambu Lab cameras, RTSPServer.cpp,
/// parseAuthorizationHeader) refuses the whole header when any value has no quotes, such as
/// `algorithm=MD5`, wherever it sits. With `qop` the RFC's bare `qop` and `nc` tokens are needed;
/// live555 never offers `qop`.
pub(crate) fn authorization(
    ch: &Challenge,
    user: &str,
    password: &str,
    method: &str,
    uri: &str,
    nc: u32,
    cnonce: &str,
) -> String {
    let ha1 = md5_hex(&format!("{user}:{}:{password}", ch.realm));
    let ha2 = md5_hex(&format!("{method}:{uri}"));
    let nc_s = format!("{nc:08x}");
    let (response, qop) = if ch.qop_auth {
        (
            md5_hex(&format!("{ha1}:{}:{nc_s}:{cnonce}:auth:{ha2}", ch.nonce)),
            format!(", qop=auth, nc={nc_s}, cnonce=\"{cnonce}\""),
        )
    } else {
        (md5_hex(&format!("{ha1}:{}:{ha2}", ch.nonce)), String::new())
    };
    let opaque = ch
        .opaque
        .as_ref()
        .map(|o| format!(", opaque=\"{o}\""))
        .unwrap_or_default();
    format!(
        "Digest username=\"{user}\", realm=\"{}\", nonce=\"{}\", uri=\"{uri}\", response=\"{response}\"{opaque}{qop}",
        ch.realm, ch.nonce
    )
}

/// The credentials and the last challenge, shared by every request of one session.
pub(crate) struct DigestAuth {
    user: String,
    password: String,
    state: Mutex<Option<(Challenge, u32)>>,
}

impl std::fmt::Debug for DigestAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DigestAuth")
            .field("user", &self.user)
            .finish_non_exhaustive()
    }
}

impl DigestAuth {
    pub(crate) fn new(user: &str, password: &str) -> Self {
        Self {
            user: user.to_owned(),
            password: password.to_owned(),
            state: Mutex::new(None),
        }
    }

    pub(crate) fn set_challenge(&self, ch: Challenge) {
        *self.state.lock().unwrap_or_else(PoisonError::into_inner) = Some((ch, 0));
    }

    /// A header for the next request, or `None` before the first challenge.
    pub(crate) fn header(&self, method: &str, uri: &str) -> Option<String> {
        let mut g = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let (ch, nc) = g.as_mut()?;
        *nc += 1;
        let mut raw = [0_u8; 8];
        getrandom::fill(&mut raw).ok()?;
        Some(authorization(
            ch,
            &self.user,
            &self.password,
            method,
            uri,
            *nc,
            &hex(&raw),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc_2617_example() {
        let ch = Challenge::parse(r#"Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41""#).unwrap();
        let h = authorization(
            &ch,
            "Mufasa",
            "Circle Of Life",
            "GET",
            "/dir/index.html",
            1,
            "0a4f113b",
        );
        assert!(
            h.contains(r#"response="6629fae49393a05397450978507c4ef1""#),
            "{h}"
        );
        assert!(h.contains("nc=00000001") && h.contains(r#"opaque="5ccc069c403ebaf9f0171e9517f40e41""#));
    }

    // live555's parser (RTSPServer.cpp, parseAuthorizationHeader): `name="value"` pairs separated by
    // commas. A pair it cannot read, a value without quotes, fails the whole header.
    fn live555_fields(h: &str) -> Option<Vec<(String, String)>> {
        let mut out = Vec::new();
        let mut rest = h.strip_prefix("Digest ")?;
        loop {
            let (k, v) = rest.trim_start().split_once('=')?;
            let (val, after) = v.trim_start().strip_prefix('"')?.split_once('"')?;
            out.push((k.trim().to_owned(), val.to_owned()));
            match after.trim_start().strip_prefix(',') {
                Some(next) => rest = next,
                None => return Some(out),
            }
        }
    }

    #[test]
    fn a_live555_server_reads_the_response() {
        let ch = Challenge::parse(r#"Digest realm="LIVE555 Streaming Media", nonce="abc""#).unwrap();
        let h = authorization(
            &ch,
            "bblp",
            "12345678",
            "DESCRIBE",
            "rtsps://192.0.2.52:322/streaming/live/1",
            3,
            "c",
        );
        let f = live555_fields(&h).unwrap_or_else(|| panic!("live555 cannot read {h}"));
        let get = |k: &str| f.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("uri"), Some("rtsps://192.0.2.52:322/streaming/live/1"));
        // RFC 2069 without qop: MD5(HA1:nonce:HA2).
        let ha1 = md5_hex("bblp:LIVE555 Streaming Media:12345678");
        let ha2 = md5_hex("DESCRIBE:rtsps://192.0.2.52:322/streaming/live/1");
        assert_eq!(
            get("response"),
            Some(md5_hex(&format!("{ha1}:abc:{ha2}")).as_str())
        );
        assert!(!h.contains("qop") && !h.contains("cnonce"), "{h}");
        // The rc11 header, with algorithm=MD5 after the response, is one live555 refuses.
        assert!(
            live555_fields(
                r#"Digest username="bblp", realm="r", nonce="n", uri="u", response="x", algorithm=MD5"#
            )
            .is_none()
        );
        // A challenge that names its algorithm gets the same quoted-only answer.
        let ch = Challenge::parse(r#"Digest realm="r", nonce="n", algorithm=MD5"#).unwrap();
        assert!(live555_fields(&authorization(&ch, "bblp", "c", "DESCRIBE", "u", 1, "x")).is_some());
    }

    #[test]
    fn the_challenge_is_described_for_the_log() {
        let ch = Challenge::parse(r#"Digest realm="r", nonce="n", qop="auth", stale=FALSE"#).unwrap();
        assert_eq!(
            ch.describe(),
            r#"realm "r", nonce "n", qop auth, algorithm none, opaque none, stale FALSE"#
        );
    }

    #[test]
    fn other_schemes_and_algorithms_are_ignored() {
        assert!(Challenge::parse("Basic realm=\"x\"").is_none());
        assert!(Challenge::parse(r#"Digest realm="x", nonce="n", algorithm=SHA-256"#).is_none());
        assert!(Challenge::parse(r#"Digest realm="a, b", nonce="n""#).is_some());
    }
}
