// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The pairing session protocol of `packages/pair` (`src/session.ts`, `src/crypto.ts`), in Rust, so
//! the hub can serve paired phones and remote agents over the relay with the app closed.
//!
//! ```text
//!   device -> host  init   { v, s, r, eD, nD, mac(kMac, s, r, eD, nD) }
//!   host -> device  accept { v, s, eH, nH, mac(kAcc, init, eH, nH) }
//!   sS   = DH(eD, host static)      the key phones pinned at pairing
//!   kAcc = HKDF(kMac || sS)
//!   keys = HKDF(DH(eD, eH) || deviceKey || sS, H(init, accept))
//!   data            { s, c, AEAD(key, nonce = dir || c, aad = s || dir) }
//! ```
//!
//! Counters rise strictly per direction, so replayed or reordered frames are dropped. Both ends
//! refuse any version but [`SESSION_VERSION`]. The byte vectors in `packages/pair/test/vectors.json`
//! pin this port to the TypeScript side.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::{Aead as _, KeyInit as _, Payload};
use ring::{digest, hkdf, hmac, signature};
use serde::{Deserialize, Serialize};
use x25519_dalek::{PublicKey, StaticSecret};

pub const PROTOCOL: &str = "sx-pair/v1";
/// Version 2 mixed the host's static key into the key schedule.
pub const SESSION_VERSION: u8 = 2;
pub const DIR_DEVICE: u8 = 3;
pub const DIR_HOST: u8 = 4;
/// Largest decrypted message, as in the TypeScript side.
pub const MAX_MESSAGE_BYTES: usize = 768 * 1024;
/// Largest ciphertext field accepted in a data frame (1 MiB of bytes as base64url).
const MAX_CIPHERTEXT_CHARS: usize = (1024_usize * 1024 * 4).div_ceil(3);

/// Unpadded base64url.
pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Canonical unpadded base64url only (no padding, no stray trailing bits).
pub fn unb64(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text).ok()
}

fn unb64_n<const N: usize>(text: &str) -> Option<[u8; N]> {
    unb64(text)?.try_into().ok()
}

/// Length-prefixed concatenation (`frame` in `bytes.ts`), so field boundaries cannot shift.
pub fn frame(parts: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(parts.iter().map(|p| p.len() + 4).sum());
    for p in parts {
        let n = u32::try_from(p.len()).unwrap_or(u32::MAX);
        out.extend_from_slice(&n.to_be_bytes());
        out.extend_from_slice(p);
    }
    out
}

struct Len(usize);

impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

/// HKDF-SHA256 with info `"sx-pair/v1 <label>"`. No salt means `HashLen` zero bytes, as in RFC 5869.
pub fn kdf(ikm: &[u8], salt: Option<&[u8]>, label: &str, length: usize) -> Vec<u8> {
    let info = format!("{PROTOCOL} {label}");
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, salt.unwrap_or(&[])).extract(ikm);
    let mut out = vec![0u8; length];
    let info_parts = [info.as_bytes()];
    // Lengths used here (32 and 64) are far below HKDF's 255 * 32 byte limit.
    if let Ok(okm) = prk.expand(&info_parts, Len(length)) {
        let _ = okm.fill(&mut out);
    }
    out
}

fn kdf32(ikm: &[u8], label: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&kdf(ikm, None, label, 32));
    out
}

fn mac_input(label: &str, parts: &[&[u8]]) -> Vec<u8> {
    let mut all: Vec<&[u8]> = vec![PROTOCOL.as_bytes(), label.as_bytes()];
    all.extend_from_slice(parts);
    frame(&all)
}

/// HMAC-SHA256 over `frame(PROTOCOL, label, ...parts)`.
pub fn mac(key: &[u8], label: &str, parts: &[&[u8]]) -> [u8; 32] {
    let tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), &mac_input(label, parts));
    let mut out = [0u8; 32];
    out.copy_from_slice(tag.as_ref());
    out
}

/// Constant-time check of a MAC.
pub fn mac_ok(key: &[u8], label: &str, parts: &[&[u8]], tag: &[u8]) -> bool {
    hmac::verify(
        &hmac::Key::new(hmac::HMAC_SHA256, key),
        &mac_input(label, parts),
        tag,
    )
    .is_ok()
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(digest::digest(&digest::SHA256, data).as_ref());
    out
}

/// Ed25519 over `frame(PROTOCOL, label, message)`, from a 32 byte seed (the TypeScript secret key).
pub fn sign(seed: &[u8; 32], label: &str, message: &[u8]) -> Option<[u8; 64]> {
    let pair = signature::Ed25519KeyPair::from_seed_unchecked(seed).ok()?;
    let sig = pair.sign(&frame(&[PROTOCOL.as_bytes(), label.as_bytes(), message]));
    sig.as_ref().try_into().ok()
}

pub fn verify_sig(public: &[u8], label: &str, message: &[u8], sig: &[u8]) -> bool {
    // A small-order key (all zeros among them) lets some verifiers accept forged signatures; such a
    // key is never a device's, so nothing signed with it counts.
    let Ok(bytes) = <[u8; 32]>::try_from(public) else {
        return false;
    };
    if curve25519_dalek::edwards::CompressedEdwardsY(bytes)
        .decompress()
        .is_none_or(|p| p.is_small_order())
    {
        return false;
    }
    signature::UnparsedPublicKey::new(&signature::ED25519, public)
        .verify(&frame(&[PROTOCOL.as_bytes(), label.as_bytes(), message]), sig)
        .is_ok()
}

/// Six digits for people to compare, shown as "123 456": 40 bits mod 10^6.
pub fn sas_digits(material: &[u8]) -> String {
    let mut n: u64 = 0;
    for i in 0..5 {
        n = (n << 8) | u64::from(material.get(i).copied().unwrap_or(0));
    }
    let s = format!("{:06}", n % 1_000_000);
    let (a, b) = s.split_at(3);
    format!("{a} {b}")
}

fn nonce(direction: u8, counter: u64) -> [u8; 24] {
    let mut n = [0u8; 24];
    for (dst, src) in n
        .iter_mut()
        .zip(std::iter::once(direction).chain(counter.to_be_bytes()))
    {
        *dst = src;
    }
    n
}

pub fn seal(key: &[u8; 32], direction: u8, counter: u64, aad: &[u8], plaintext: &[u8]) -> Option<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).ok()?;
    cipher
        .encrypt(&nonce(direction, counter).into(), Payload { msg: plaintext, aad })
        .ok()
}

/// `None` when the tag does not verify.
pub fn open(key: &[u8; 32], direction: u8, counter: u64, aad: &[u8], ciphertext: &[u8]) -> Option<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).ok()?;
    cipher
        .decrypt(
            &nonce(direction, counter).into(),
            Payload { msg: ciphertext, aad },
        )
        .ok()
}

/// X25519. `None` for a low-order peer key, which would give an all-zero secret.
pub fn dh(secret: &[u8; 32], peer: &[u8; 32]) -> Option<[u8; 32]> {
    let shared = StaticSecret::from(*secret).diffie_hellman(&PublicKey::from(*peer));
    shared.was_contributory().then(|| *shared.as_bytes())
}

pub fn dh_public(secret: &[u8; 32]) -> [u8; 32] {
    PublicKey::from(&StaticSecret::from(*secret)).to_bytes()
}

/// The relay routes of one pairing: the host listens on `host`, the device on `device`.
pub fn pairing_routes(device_key: &[u8]) -> (String, String) {
    (
        b64(&kdf(device_key, None, "route host", 32)),
        b64(&kdf(device_key, None, "route device", 32)),
    )
}

pub fn mac_key(device_key: &[u8]) -> [u8; 32] {
    kdf32(device_key, "session mac")
}

// ---------------------------------------------------------------------------
// Frames

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InitFrame {
    pub k: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub v: Option<u8>,
    pub s: String,
    pub r: String,
    pub e: String,
    pub n: String,
    pub m: String,
    /// An introduction grant on first contact. The hub does not take introductions yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub g: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AcceptFrame {
    pub k: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub v: Option<u8>,
    pub s: String,
    pub e: String,
    pub n: String,
    pub m: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataFrame {
    pub k: String,
    pub s: String,
    pub c: u64,
    pub x: String,
}

/// Any session frame, by its `k`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionFrame {
    Init(InitFrame),
    Accept(AcceptFrame),
    Data(DataFrame),
    Refuse { s: String, reason: String },
}

fn is_b64(s: &str, bytes: usize) -> bool {
    s.len() == (bytes * 4).div_ceil(3)
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// Parses a session frame with the same shape checks as `schema.ts`. Anything else is `None`.
pub fn parse_frame(text: &str) -> Option<SessionFrame> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    match v.get("k")?.as_str()? {
        "init" => {
            let f: InitFrame = serde_json::from_value(v).ok()?;
            (is_b64(&f.s, 16) && is_b64(&f.r, 32) && is_b64(&f.e, 32) && is_b64(&f.n, 16) && is_b64(&f.m, 32))
                .then_some(SessionFrame::Init(f))
        }
        "accept" => {
            let f: AcceptFrame = serde_json::from_value(v).ok()?;
            (is_b64(&f.s, 16) && is_b64(&f.e, 32) && is_b64(&f.n, 16) && is_b64(&f.m, 32))
                .then_some(SessionFrame::Accept(f))
        }
        "data" => {
            let f: DataFrame = serde_json::from_value(v).ok()?;
            let ok = is_b64(&f.s, 16)
                && f.x.len() <= MAX_CIPHERTEXT_CHARS
                && f.x.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                // JavaScript numbers are exact up to 2^53.
                && f.c < (1 << 53);
            ok.then_some(SessionFrame::Data(f))
        }
        "refuse" => {
            let s = v.get("s")?.as_str()?.to_owned();
            let reason = v.get("reason")?.as_str()?.to_owned();
            (is_b64(&s, 16) && matches!(reason.as_str(), "unknown" | "busy" | "update"))
                .then_some(SessionFrame::Refuse { s, reason })
        }
        _ => None,
    }
}

fn init_mac_parts(f: &InitFrame) -> [&[u8]; 4] {
    [f.s.as_bytes(), f.r.as_bytes(), f.e.as_bytes(), f.n.as_bytes()]
}

fn accept_mac_parts<'a>(init: &'a InitFrame, e: &'a str, n: &'a str) -> [&'a [u8]; 6] {
    [
        init.s.as_bytes(),
        init.r.as_bytes(),
        init.e.as_bytes(),
        init.n.as_bytes(),
        e.as_bytes(),
        n.as_bytes(),
    ]
}

/// The accept MAC needs the host's static key as well, so a device key alone cannot forge it.
fn accept_key(device_key: &[u8], static_shared: &[u8; 32]) -> [u8; 32] {
    kdf32(
        &[mac_key(device_key).as_slice(), static_shared].concat(),
        "session accept mac v2",
    )
}

fn session_keys(
    shared: &[u8; 32],
    device_key: &[u8],
    static_shared: &[u8; 32],
    init: &InitFrame,
    e: &str,
    n: &str,
) -> ([u8; 32], [u8; 32]) {
    let salt = sha256(&frame(&[
        b"session",
        init.s.as_bytes(),
        init.r.as_bytes(),
        init.e.as_bytes(),
        init.n.as_bytes(),
        e.as_bytes(),
        n.as_bytes(),
    ]));
    let mut ikm = shared.to_vec();
    ikm.extend_from_slice(device_key);
    ikm.extend_from_slice(static_shared);
    let okm = kdf(&ikm, Some(&salt), "session keys v2", 64);
    let mut to_host = [0u8; 32];
    let mut to_device = [0u8; 32];
    to_host.copy_from_slice(okm.get(..32).unwrap_or(&[0; 32]));
    to_device.copy_from_slice(okm.get(32..64).unwrap_or(&[0; 32]));
    (to_host, to_device)
}

/// Whether an init speaks this session version. Hosts answer others with `refuse {reason: "update"}`.
pub fn init_current(init: &InitFrame) -> bool {
    init.v == Some(SESSION_VERSION)
}

/// Checks an init's MAC against a pairing's device key.
pub fn verify_init(init: &InitFrame, device_key: &[u8]) -> bool {
    unb64(&init.m).is_some_and(|m| mac_ok(&mac_key(device_key), "init", &init_mac_parts(init), &m))
}

/// One direction pair of an established session.
pub struct Channel {
    pub sid: String,
    send_key: [u8; 32],
    recv_key: [u8; 32],
    send_dir: u8,
    recv_dir: u8,
    send_counter: u64,
    last_recv: Option<u64>,
}

impl Channel {
    fn aad(&self, dir: u8) -> Vec<u8> {
        frame(&[b"data", self.sid.as_bytes(), &u32::from(dir).to_be_bytes()])
    }

    /// Seals one message (the JSON text) into a data frame.
    pub fn seal(&mut self, plaintext: &[u8]) -> Option<DataFrame> {
        if plaintext.len() > MAX_MESSAGE_BYTES {
            return None;
        }
        let c = self.send_counter;
        let x = seal(
            &self.send_key,
            self.send_dir,
            c,
            &self.aad(self.send_dir),
            plaintext,
        )?;
        self.send_counter += 1;
        Some(DataFrame {
            k: "data".to_owned(),
            s: self.sid.clone(),
            c,
            x: b64(&x),
        })
    }

    /// Seals and encodes a frame for the wire.
    pub fn seal_text(&mut self, plaintext: &str) -> Option<String> {
        self.seal(plaintext.as_bytes())
            .and_then(|f| serde_json::to_string(&f).ok())
    }

    /// Opens a data frame. `None` when it fails to decrypt, is too large, belongs to another
    /// session or does not come after the last one.
    pub fn open(&mut self, f: &DataFrame) -> Option<Vec<u8>> {
        if f.s != self.sid || self.last_recv.is_some_and(|l| f.c <= l) {
            return None;
        }
        let x = unb64(&f.x)?;
        let pt = open(&self.recv_key, self.recv_dir, f.c, &self.aad(self.recv_dir), &x)?;
        if pt.len() > MAX_MESSAGE_BYTES {
            return None;
        }
        self.last_recv = Some(f.c);
        Some(pt)
    }
}

/// Host side: answers a current init whose MAC was checked with [`verify_init`]. `eph` and `nonce`
/// are fresh random bytes, `host_dh` the host identity's static X25519 secret. Returns the accept
/// frame to send and the host end of the channel.
pub fn accept(
    eph: &[u8; 32],
    nonce: &[u8; 16],
    init: &InitFrame,
    device_key: &[u8],
    host_dh: &[u8; 32],
) -> Option<(AcceptFrame, Channel)> {
    if !init_current(init) {
        return None;
    }
    let e_d = unb64_n::<32>(&init.e)?;
    let shared = dh(eph, &e_d)?;
    let static_shared = dh(host_dh, &e_d)?;
    let e = b64(&dh_public(eph));
    let n = b64(nonce);
    let m = b64(&mac(
        &accept_key(device_key, &static_shared),
        "accept",
        &accept_mac_parts(init, &e, &n),
    ));
    let (to_host, to_device) = session_keys(&shared, device_key, &static_shared, init, &e, &n);
    let frame = AcceptFrame {
        k: "accept".to_owned(),
        v: Some(SESSION_VERSION),
        s: init.s.clone(),
        e,
        n,
        m,
    };
    let channel = Channel {
        sid: init.s.clone(),
        send_key: to_device,
        recv_key: to_host,
        send_dir: DIR_HOST,
        recv_dir: DIR_DEVICE,
        send_counter: 0,
        last_recv: None,
    };
    Some((frame, channel))
}

/// Device side of a session being opened: the init to send, waiting for the host's accept.
pub struct Opening {
    pub init: InitFrame,
    eph: [u8; 32],
    device_key: Vec<u8>,
    host_dh_pub: [u8; 32],
}

/// Why a host's accept was not taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceptError {
    /// Another session, a bad MAC or a bad key.
    Bad,
    /// The host speaks another session version: one side needs an update.
    Outdated,
}

impl Opening {
    /// `eph`, `sid` and `nonce` are fresh random bytes. `route` defaults to the pairing's host route.
    /// `host_dh_pub` is the host's static key (`dhPub`), pinned at pairing.
    pub fn new(
        eph: &[u8; 32],
        sid: &[u8; 16],
        nonce: &[u8; 16],
        route: Option<&str>,
        device_key: &[u8],
        host_dh_pub: &[u8; 32],
    ) -> Self {
        let r = route.map_or_else(|| pairing_routes(device_key).0, str::to_owned);
        let mut init = InitFrame {
            k: "init".to_owned(),
            v: Some(SESSION_VERSION),
            s: b64(sid),
            r,
            e: b64(&dh_public(eph)),
            n: b64(nonce),
            m: String::new(),
            g: None,
        };
        init.m = b64(&mac(&mac_key(device_key), "init", &init_mac_parts(&init)));
        Self {
            init,
            eph: *eph,
            device_key: device_key.to_vec(),
            host_dh_pub: *host_dh_pub,
        }
    }

    /// Checks the host's accept and returns the device end of the channel. An accept of another
    /// version is [`AcceptError::Outdated`], never tried with an older key schedule.
    pub fn finish(&self, a: &AcceptFrame) -> Result<Channel, AcceptError> {
        if a.s != self.init.s {
            return Err(AcceptError::Bad);
        }
        if a.v != Some(SESSION_VERSION) {
            return Err(AcceptError::Outdated);
        }
        let m = unb64(&a.m).ok_or(AcceptError::Bad)?;
        let static_shared = dh(&self.eph, &self.host_dh_pub).ok_or(AcceptError::Bad)?;
        if !mac_ok(
            &accept_key(&self.device_key, &static_shared),
            "accept",
            &accept_mac_parts(&self.init, &a.e, &a.n),
            &m,
        ) {
            return Err(AcceptError::Bad);
        }
        let shared = dh(&self.eph, &unb64_n::<32>(&a.e).ok_or(AcceptError::Bad)?).ok_or(AcceptError::Bad)?;
        let (to_host, to_device) =
            session_keys(&shared, &self.device_key, &static_shared, &self.init, &a.e, &a.n);
        Ok(Channel {
            sid: self.init.s.clone(),
            send_key: to_host,
            recv_key: to_device,
            send_dir: DIR_DEVICE,
            recv_dir: DIR_HOST,
            send_counter: 0,
            last_recv: None,
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::format_collect)]
    use super::*;
    use ring::signature::KeyPair as _;
    use serde_json::Value;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn arr<const N: usize>(s: &str) -> [u8; N] {
        hex(s).try_into().unwrap()
    }

    #[test]
    fn l3_small_order_keys_verify_nothing() {
        let pair = ring::signature::Ed25519KeyPair::from_seed_unchecked(&[5; 32]).unwrap();
        let msg = frame(&[PROTOCOL.as_bytes(), b"approval", b"m"]);
        let sig = pair.sign(&msg);
        assert!(verify_sig(
            pair.public_key().as_ref(),
            "approval",
            b"m",
            sig.as_ref()
        ));
        // The identity point (all zeros is order 4, 01 00.. is order 1) and a point of order 8.
        let mut one = [0u8; 32];
        one[0] = 1;
        for bad in [
            [0u8; 32],
            one,
            arr::<32>("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"),
        ] {
            assert!(
                !verify_sig(&bad, "approval", b"m", &[0u8; 64]),
                "{}",
                to_hex(&bad)
            );
        }
        assert!(!verify_sig(&[1u8; 31], "approval", b"m", sig.as_ref()));
    }

    fn to_hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn vectors() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../pair/test/vectors.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn s<'a>(v: &'a Value, path: &[&str]) -> &'a str {
        let mut cur = v;
        for p in path {
            cur = &cur[*p];
        }
        cur.as_str().unwrap()
    }

    #[test]
    fn primitives_match_the_typescript_side() {
        let v = vectors();
        let p = &v["primitives"];
        assert_eq!(
            to_hex(&frame(&[b"sx-pair/v1", b"label", &[0, 255, 16]])),
            s(p, &["frame", "hex"])
        );
        let ikm = hex(s(p, &["kdf", "ikm"]));
        assert_eq!(to_hex(&kdf(&ikm, None, "route host", 32)), s(p, &["kdf", "hex"]));
        assert_eq!(
            to_hex(&kdf(&ikm, Some(&[1, 2]), "session keys", 64)),
            s(p, &["kdfSalted", "hex"])
        );
        assert_eq!(to_hex(&mac(&ikm, "init", &[b"a", b"b"])), s(p, &["mac", "hex"]));
        assert_eq!(
            sas_digits(&hex(s(p, &["sas", "material"]))),
            s(p, &["sas", "digits"])
        );
        let seed: [u8; 32] = arr(s(p, &["sign", "seed"]));
        let msg = hex(s(p, &["sign", "message"]));
        let sig = sign(&seed, "decision", &msg).unwrap();
        assert_eq!(to_hex(&sig), s(p, &["sign", "sig"]));
        let public = signature::Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
        assert!(verify_sig(public.public_key().as_ref(), "decision", &msg, &sig));
        assert!(!verify_sig(public.public_key().as_ref(), "other", &msg, &sig));
        assert_eq!(b64(&hex(s(&v, &["b64url", "hex"]))), s(&v, &["b64url", "text"]));
        assert!(unb64("AB").is_none(), "stray trailing bits are not canonical");
    }

    #[test]
    fn session_frames_match_byte_for_byte() {
        let v = vectors();
        let sv = &v["session"];
        let dk = hex(s(sv, &["deviceKey"]));
        assert_eq!(to_hex(&mac_key(&dk)), s(sv, &["macKey"]));
        let (host_route, device_route) = pairing_routes(&dk);
        assert_eq!(
            (host_route.as_str(), device_route.as_str()),
            (s(sv, &["routes", "host"]), s(sv, &["routes", "device"]))
        );

        let dr: Vec<&str> = sv["deviceRandom"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect();
        let hr: Vec<&str> = sv["hostRandom"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect();
        // The device draws its ephemeral key, the session id, then its nonce; the host its key, then its nonce.
        let host_dh: [u8; 32] = arr(s(sv, &["hostDhSecret"]));
        let host_pub: [u8; 32] = arr(s(sv, &["hostDhPub"]));
        assert_eq!(dh_public(&host_dh), host_pub);
        let opening = Opening::new(&arr(dr[0]), &arr(dr[1]), &arr(dr[2]), None, &dk, &host_pub);
        assert_eq!(serde_json::to_string(&opening.init).unwrap(), s(sv, &["init"]));

        // The TypeScript device's init, answered by this host; this device's init, answered by the TypeScript host.
        let Some(SessionFrame::Init(init)) = parse_frame(s(sv, &["init"])) else {
            panic!("init")
        };
        assert!(verify_init(&init, &dk));
        assert!(!verify_init(&init, &[7u8; 32]));
        let (acc, mut host) = accept(&arr(hr[0]), &arr(hr[1]), &init, &dk, &host_dh).unwrap();
        assert_eq!(serde_json::to_string(&acc).unwrap(), s(sv, &["accept"]));
        let Some(SessionFrame::Accept(ts_accept)) = parse_frame(s(sv, &["accept"])) else {
            panic!("accept")
        };
        assert!(opening.finish(&ts_accept).is_ok());

        let mut device = opening.finish(&acc).unwrap();
        for m in sv["fromDevice"].as_array().unwrap() {
            assert_eq!(device.seal_text(s(m, &["plain"])).unwrap(), s(m, &["frame"]));
            let Some(SessionFrame::Data(f)) = parse_frame(s(m, &["frame"])) else {
                panic!("data")
            };
            assert_eq!(host.open(&f).unwrap(), s(m, &["plain"]).as_bytes());
            // A replay of the same frame is dropped.
            assert!(host.open(&f).is_none());
        }
        for m in sv["fromHost"].as_array().unwrap() {
            assert_eq!(host.seal_text(s(m, &["plain"])).unwrap(), s(m, &["frame"]));
            let Some(SessionFrame::Data(f)) = parse_frame(s(m, &["frame"])) else {
                panic!("data")
            };
            assert_eq!(device.open(&f).unwrap(), s(m, &["plain"]).as_bytes());
        }
    }

    #[test]
    fn tampered_reflected_and_low_order_inputs_fail() {
        let dk = [9u8; 32];
        let host_dh = [8u8; 32];
        let opening = Opening::new(&[1; 32], &[2; 16], &[3; 16], None, &dk, &dh_public(&host_dh));
        let (acc, mut host) = accept(&[4; 32], &[5; 16], &opening.init, &dk, &host_dh).unwrap();
        let mut device = opening.finish(&acc).unwrap();
        let mut f = device.seal(b"{\"id\":1}").unwrap();
        // Reflected back to the device, a frame fails: the directions use different keys.
        assert!(device.open(&f).is_none());
        f.x.replace_range(0..1, if f.x.starts_with('A') { "B" } else { "A" });
        assert!(host.open(&f).is_none());
        let mut bad = acc.clone();
        bad.n = b64(&[6; 16]);
        assert_eq!(opening.finish(&bad).err(), Some(AcceptError::Bad));
        // An all-zero public key is low order and gives no session.
        let mut low = opening.init.clone();
        low.e = b64(&[0; 32]);
        assert!(accept(&[4; 32], &[5; 16], &low, &dk, &host_dh).is_none());
    }

    #[test]
    fn l2_a_device_key_alone_cannot_answer_as_the_host() {
        let dk = [9u8; 32];
        let real = dh_public(&[8u8; 32]);
        let opening = Opening::new(&[1; 32], &[2; 16], &[3; 16], None, &dk, &real);
        // Someone with the device key but another static key forges no accept.
        let (acc, _) = accept(&[4; 32], &[5; 16], &opening.init, &dk, &[7u8; 32]).unwrap();
        assert_eq!(opening.finish(&acc).err(), Some(AcceptError::Bad));
    }

    #[test]
    fn other_versions_are_refused_both_ways() {
        let dk = [9u8; 32];
        let host_dh = [8u8; 32];
        let opening = Opening::new(&[1; 32], &[2; 16], &[3; 16], None, &dk, &dh_public(&host_dh));
        let mut old = opening.init.clone();
        old.v = None;
        assert!(
            verify_init(&old, &dk),
            "the init MAC is unchanged, so an old init still reads as this pairing"
        );
        assert!(!init_current(&old));
        assert!(accept(&[4; 32], &[5; 16], &old, &dk, &host_dh).is_none());
        let (mut acc, _) = accept(&[4; 32], &[5; 16], &opening.init, &dk, &host_dh).unwrap();
        acc.v = None;
        assert_eq!(opening.finish(&acc).err(), Some(AcceptError::Outdated));
        let refuse = format!(
            "{{\"k\":\"refuse\",\"s\":\"{}\",\"reason\":\"update\"}}",
            opening.init.s
        );
        assert!(
            matches!(parse_frame(&refuse), Some(SessionFrame::Refuse { reason, .. }) if reason == "update")
        );
    }
}
