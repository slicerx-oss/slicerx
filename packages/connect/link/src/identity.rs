// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The hub's own key, so a client can tell the real hub from whatever else listens on its port
//! before it sends a pairing code.
//!
//! The hub keeps an Ed25519 key pair in its state directory (`hub-key`, PKCS#8, mode 0600; the
//! public half in `hub-key.pub`, base64). Before pairing, a client sends `hello {nonce}`. The hub
//! picks its own nonce and signs the transcript: [`HELLO_CONTEXT`], the client's nonce, its nonce,
//! and the port it listens on (two bytes, big endian). The port binds the signature to this
//! listener, so a program on another port cannot relay a real hub's answer. A client that knows the
//! public key (the MCP server reads `hub-key.pub`; the desktop app gets it in process; a browser
//! pins it at the first pairing) checks it and sends nothing to a hub that fails. It then pairs by
//! running the code exchange (`CPace`, `sx_cpace::pair`) bound to the hub key, the port and both
//! nonces: the code never crosses the socket, and a program posing as the hub gets one guess per
//! attempt, nothing it can test offline. Without a state directory the key lives for the life of
//! the process.
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{Value, json};

use crate::rpc::{Rpc, RpcError};

pub(crate) const KEY_FILE: &str = "hub-key";
pub(crate) const PUB_FILE: &str = "hub-key.pub";
/// What the hub signs, before the client nonce, the hub nonce and the port.
pub const HELLO_CONTEXT: &[u8] = b"sx-link hello v2\n";

/// The nonces of one connection's `hello`, which its code exchange is bound to.
#[derive(Debug, Clone)]
pub(crate) struct Hello {
    pub client: Vec<u8>,
    pub hub: Vec<u8>,
}

pub(crate) struct HubIdentity {
    pair: Ed25519KeyPair,
}

impl HubIdentity {
    /// Loads the key from `dir`, or makes one and saves it there (0600).
    pub(crate) fn open(dir: Option<&Path>) -> std::io::Result<Self> {
        let err = |m: &str| std::io::Error::other(m.to_owned());
        if let Some(d) = dir
            && let Ok(text) = std::fs::read_to_string(d.join(KEY_FILE))
            && let Ok(der) = B64.decode(text.trim())
            && let Ok(pair) = Ed25519KeyPair::from_pkcs8(&der)
        {
            return Ok(Self { pair });
        }
        let der = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| err("cannot make the hub key"))?;
        let pair = Ed25519KeyPair::from_pkcs8(der.as_ref()).map_err(|_| err("cannot read the hub key"))?;
        if let Some(d) = dir {
            sx_connect::write_private(&d.join(KEY_FILE), B64.encode(der.as_ref()).as_bytes())?;
            let me = Self { pair };
            sx_connect::write_private(&d.join(PUB_FILE), format!("{}\n", me.public_b64()).as_bytes())?;
            return Ok(me);
        }
        Ok(Self { pair })
    }

    pub(crate) fn public_b64(&self) -> String {
        B64.encode(self.pair.public_key().as_ref())
    }

    pub(crate) fn public_bytes(&self) -> &[u8] {
        self.pair.public_key().as_ref()
    }

    /// `hello {nonce}` on the listener at `port`: `{hubKey, hubNonce, port, sig}`, and the nonces to
    /// keep for the code exchange. The client nonce is 16 to 64 bytes of base64.
    pub(crate) fn hello(&self, p: &Value, port: u16) -> Rpc<(Value, Hello)> {
        let client = p
            .get("nonce")
            .and_then(Value::as_str)
            .and_then(|n| B64.decode(n).ok())
            .filter(|n| (16..=64).contains(&n.len()))
            .ok_or_else(|| RpcError::new("bad_request", "nonce is 16 to 64 bytes of base64"))?;
        let mut hub = vec![0_u8; 32];
        ring::rand::SecureRandom::fill(&SystemRandom::new(), &mut hub)
            .map_err(|_| RpcError::new("protocol", "no randomness"))?;
        let mut msg = HELLO_CONTEXT.to_vec();
        msg.extend_from_slice(&client);
        msg.extend_from_slice(&hub);
        msg.extend_from_slice(&port.to_be_bytes());
        let sig = self.pair.sign(&msg);
        let reply = json!({
            "hubKey": self.public_b64(),
            "hubNonce": B64.encode(&hub),
            "port": port,
            "sig": B64.encode(sig.as_ref()),
        });
        Ok((reply, Hello { client, hub }))
    }
}

/// The running hub's public key from its state directory, for clients that read it there.
pub fn read_hub_key(state_dir: &Path) -> std::io::Result<String> {
    Ok(std::fs::read_to_string(state_dir.join(PUB_FILE))?
        .trim()
        .to_owned())
}

/// A short, readable form of a hub key for people to compare: the first 80 bits of SHA-256 over
/// the key bytes in Crockford base32, as four groups of four (`CC6W TAB6 RGSP D48J`). The app
/// shows the same form, so a person can check that the program answering is their bridge.
/// `None` for a key that is not base64.
pub fn hub_fingerprint(hub_key_b64: &str) -> Option<String> {
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let key = B64.decode(hub_key_b64.trim()).ok()?;
    let digest = ring::digest::digest(&ring::digest::SHA256, &key);
    let n = digest
        .as_ref()
        .iter()
        .take(10)
        .fold(0_u128, |acc, b| (acc << 8) | u128::from(*b));
    let chars: Vec<char> = (0..16)
        .map(|i| {
            let at = usize::try_from((n >> (5 * (15 - i))) & 31).unwrap_or(0);
            ALPHABET.get(at).map_or('0', |c| char::from(*c))
        })
        .collect();
    Some(
        chars
            .chunks(4)
            .map(|c| c.iter().collect::<String>())
            .collect::<Vec<_>>()
            .join(" "),
    )
}

#[cfg(test)]
mod tests {
    use ring::signature::{ED25519, UnparsedPublicKey};

    use super::*;

    // The same vector is in packages/contracts (hubFingerprint), so app and CLI agree.
    #[test]
    fn fingerprints_are_short_and_match_the_app() {
        assert_eq!(
            hub_fingerprint("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=").as_deref(),
            Some("CC6W TAB6 RGSP D48J")
        );
        assert_eq!(hub_fingerprint("not base64!"), None);
    }

    #[test]
    fn the_key_survives_a_restart_and_signs_hellos() {
        let dir = std::env::temp_dir().join(format!("sx-hub-key-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = HubIdentity::open(Some(&dir)).unwrap();
        let b = HubIdentity::open(Some(&dir)).unwrap();
        assert_eq!(a.public_b64(), b.public_b64());
        assert_eq!(read_hub_key(&dir).unwrap(), a.public_b64());
        let nonce = [7_u8; 32];
        let (r, hello) = a.hello(&json!({ "nonce": B64.encode(nonce) }), 47615).unwrap();
        let sig = B64.decode(r["sig"].as_str().unwrap()).unwrap();
        let transcript = |port: u16| {
            let mut msg = HELLO_CONTEXT.to_vec();
            msg.extend_from_slice(&nonce);
            msg.extend_from_slice(&hello.hub);
            msg.extend_from_slice(&port.to_be_bytes());
            msg
        };
        let key = B64.decode(r["hubKey"].as_str().unwrap()).unwrap();
        UnparsedPublicKey::new(&ED25519, &key)
            .verify(&transcript(47615), &sig)
            .unwrap();
        assert!(
            UnparsedPublicKey::new(&ED25519, &key)
                .verify(&transcript(47616), &sig)
                .is_err(),
            "bound to the port"
        );
        let other = HubIdentity::open(None).unwrap();
        let k2 = B64.decode(other.public_b64()).unwrap();
        assert!(
            UnparsedPublicKey::new(&ED25519, &k2)
                .verify(&transcript(47615), &sig)
                .is_err()
        );
        assert!(
            a.hello(&json!({ "nonce": "AA==" }), 1).is_err(),
            "short nonces are refused"
        );
        assert_eq!(hello.client, nonce);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(KEY_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
