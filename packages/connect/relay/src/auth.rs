// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Account sessions: a short-lived relay token (a JWT with audience `sx-relay`) checked against the
//! keys of the service that mints it. The relay never takes the account's own Supabase session,
//! which works against the whole backend: the app exchanges it for a relay token first (README.md,
//! "Relay tokens"). The relay learns the account id and the expiry, and nothing else.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::{hmac, signature};
use serde::Deserialize;
use serde_json::Value;

/// Clock difference tolerated on `exp`, in milliseconds.
const LEEWAY_MS: u64 = 30_000;
/// The audience of relay tokens. Nothing else is accepted.
pub const RELAY_AUDIENCE: &str = "sx-relay";

/// One key the relay accepts tokens from.
pub enum Key {
    /// The project's shared JWT secret (Supabase's legacy signing).
    Hs256(hmac::Key),
    /// An asymmetric P-256 key from the project's JWKS (uncompressed point).
    Es256 { kid: Option<String>, point: Vec<u8> },
    /// An RSA key from the project's JWKS.
    Rs256 {
        kid: Option<String>,
        n: Vec<u8>,
        e: Vec<u8>,
    },
}

/// Checks access tokens.
pub struct Verifier {
    keys: Vec<Key>,
    /// Required `iss`, when set (for example `https://<project>.supabase.co/auth/v1`).
    pub issuer: Option<String>,
    /// Required `aud`: `sx-relay`, so a user's own session (`authenticated`) is refused.
    pub audience: String,
}

/// What a valid token says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub account: String,
    pub expires_ms: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    Malformed,
    UnknownKey,
    BadSignature,
    Expired,
    WrongAudience,
    WrongIssuer,
    BadSubject,
    /// An anonymous sign-in (`is_anonymous`): no account tier for it.
    Anonymous,
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    kid: Option<String>,
}

#[derive(Deserialize)]
struct Jwk {
    kty: String,
    kid: Option<String>,
    alg: Option<String>,
    crv: Option<String>,
    x: Option<String>,
    y: Option<String>,
    n: Option<String>,
    e: Option<String>,
}

#[derive(Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

fn b64(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s).ok()
}

impl Verifier {
    pub fn new(keys: Vec<Key>) -> Self {
        Self {
            keys,
            issuer: None,
            audience: RELAY_AUDIENCE.to_owned(),
        }
    }

    /// A verifier for the project's shared secret.
    pub fn hs256(secret: &[u8]) -> Self {
        Self::new(vec![Key::Hs256(hmac::Key::new(hmac::HMAC_SHA256, secret))])
    }

    /// Also accepts the project's shared secret, for projects moving from it to signing keys.
    #[must_use]
    pub fn with_hs256(mut self, secret: &[u8]) -> Self {
        self.keys
            .push(Key::Hs256(hmac::Key::new(hmac::HMAC_SHA256, secret)));
        self
    }

    /// Public keys from a JWKS document (`/auth/v1/.well-known/jwks.json`). Keys of other types
    /// are skipped; an empty result is an error.
    pub fn from_jwks(json: &str) -> Result<Self, String> {
        let doc: Jwks = serde_json::from_str(json).map_err(|e| format!("JWKS: {e}"))?;
        let mut keys = Vec::new();
        for k in doc.keys {
            match (k.kty.as_str(), k.crv.as_deref()) {
                ("EC", Some("P-256")) if k.alg.as_deref().is_none_or(|a| a == "ES256") => {
                    let (Some(x), Some(y)) = (k.x.as_deref().and_then(b64), k.y.as_deref().and_then(b64))
                    else {
                        return Err("JWKS: EC key without x and y".to_owned());
                    };
                    if x.len() != 32 || y.len() != 32 {
                        return Err("JWKS: EC key of the wrong size".to_owned());
                    }
                    let mut point = Vec::with_capacity(65);
                    point.push(4);
                    point.extend_from_slice(&x);
                    point.extend_from_slice(&y);
                    keys.push(Key::Es256 { kid: k.kid, point });
                }
                ("RSA", _) if k.alg.as_deref().is_none_or(|a| a == "RS256") => {
                    let (Some(n), Some(e)) = (k.n.as_deref().and_then(b64), k.e.as_deref().and_then(b64))
                    else {
                        return Err("JWKS: RSA key without n and e".to_owned());
                    };
                    keys.push(Key::Rs256 { kid: k.kid, n, e });
                }
                _ => {}
            }
        }
        if keys.is_empty() {
            return Err("JWKS: no ES256 or RS256 keys".to_owned());
        }
        Ok(Self::new(keys))
    }

    /// Checks the signature, `exp`, `aud`, `iss` and the shape of `sub`.
    pub fn verify(&self, token: &str, now_ms: u64) -> Result<Session, AuthError> {
        let mut parts = token.split('.');
        let (Some(h), Some(p), Some(s), None) = (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(AuthError::Malformed);
        };
        let header: Header = b64(h)
            .and_then(|b| serde_json::from_slice(&b).ok())
            .ok_or(AuthError::Malformed)?;
        let sig = b64(s).ok_or(AuthError::Malformed)?;
        let signed = &token.as_bytes()[..h.len() + 1 + p.len()];
        let kid_ok = |kid: &Option<String>| header.kid.is_none() || kid.is_none() || *kid == header.kid;
        let mut tried = false;
        let mut good = false;
        for key in &self.keys {
            let ok = match (key, header.alg.as_str()) {
                (Key::Hs256(k), "HS256") => {
                    tried = true;
                    hmac::verify(k, signed, &sig).is_ok()
                }
                (Key::Es256 { kid, point }, "ES256") if kid_ok(kid) => {
                    tried = true;
                    signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point)
                        .verify(signed, &sig)
                        .is_ok()
                }
                (Key::Rs256 { kid, n, e }, "RS256") if kid_ok(kid) => {
                    tried = true;
                    signature::RsaPublicKeyComponents { n, e }
                        .verify(&signature::RSA_PKCS1_2048_8192_SHA256, signed, &sig)
                        .is_ok()
                }
                _ => false,
            };
            if ok {
                good = true;
                break;
            }
        }
        if !tried {
            return Err(AuthError::UnknownKey);
        }
        if !good {
            return Err(AuthError::BadSignature);
        }
        let claims: Value = b64(p)
            .and_then(|b| serde_json::from_slice(&b).ok())
            .ok_or(AuthError::Malformed)?;
        let exp = claims
            .get("exp")
            .and_then(Value::as_u64)
            .ok_or(AuthError::Malformed)?;
        let expires_ms = exp.saturating_mul(1000);
        if now_ms >= expires_ms.saturating_add(LEEWAY_MS) {
            return Err(AuthError::Expired);
        }
        let aud_ok = match claims.get("aud") {
            Some(Value::String(a)) => *a == self.audience,
            Some(Value::Array(list)) => list.iter().any(|a| a.as_str() == Some(self.audience.as_str())),
            _ => false,
        };
        if !aud_ok {
            return Err(AuthError::WrongAudience);
        }
        if let Some(iss) = &self.issuer
            && claims.get("iss").and_then(Value::as_str) != Some(iss.as_str())
        {
            return Err(AuthError::WrongIssuer);
        }
        if claims.get("is_anonymous").and_then(Value::as_bool) == Some(true) {
            return Err(AuthError::Anonymous);
        }
        let sub = claims
            .get("sub")
            .and_then(Value::as_str)
            .ok_or(AuthError::BadSubject)?;
        if sub.is_empty() || sub.len() > 64 || !sub.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
            return Err(AuthError::BadSubject);
        }
        Ok(Session {
            account: sub.to_owned(),
            expires_ms,
        })
    }
}

/// Signs an HS256 token. For tests and the local test relay only.
pub fn sign_hs256(secret: &[u8], claims: &Value) -> String {
    let h = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let p = URL_SAFE_NO_PAD.encode(claims.to_string());
    let input = format!("{h}.{p}");
    let tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, secret), input.as_bytes());
    format!("{input}.{}", URL_SAFE_NO_PAD.encode(tag.as_ref()))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair as _};
    use serde_json::json;

    const NOW: u64 = 1_790_899_200_000;

    fn claims(exp_s: u64) -> Value {
        json!({ "sub": "8d0f6f7e-1c2a-4b7e-9a51-3f0e2b1d4c55", "aud": "sx-relay", "exp": exp_s, "iss": "https://p.supabase.co/auth/v1" })
    }

    #[test]
    fn hs256_tokens_check_signature_expiry_and_audience() {
        let v = Verifier::hs256(b"secret");
        let good = sign_hs256(b"secret", &claims(NOW / 1000 + 60));
        assert_eq!(
            v.verify(&good, NOW).unwrap().account,
            "8d0f6f7e-1c2a-4b7e-9a51-3f0e2b1d4c55"
        );
        assert_eq!(
            v.verify(&sign_hs256(b"other", &claims(NOW / 1000 + 60)), NOW),
            Err(AuthError::BadSignature)
        );
        assert_eq!(
            v.verify(&sign_hs256(b"secret", &claims(NOW / 1000 - 60)), NOW),
            Err(AuthError::Expired)
        );
        let mut anon = claims(NOW / 1000 + 60);
        anon["aud"] = json!("anon");
        assert_eq!(
            v.verify(&sign_hs256(b"secret", &anon), NOW),
            Err(AuthError::WrongAudience)
        );
        // M4: the account's own Supabase session is not a relay token.
        let mut session = claims(NOW / 1000 + 60);
        session["aud"] = json!("authenticated");
        assert_eq!(
            v.verify(&sign_hs256(b"secret", &session), NOW),
            Err(AuthError::WrongAudience)
        );
        // An anonymous sign-in gets no account tier.
        let mut guest = claims(NOW / 1000 + 60);
        guest["is_anonymous"] = json!(true);
        assert_eq!(
            v.verify(&sign_hs256(b"secret", &guest), NOW),
            Err(AuthError::Anonymous)
        );
        let mut odd = claims(NOW / 1000 + 60);
        odd["sub"] = json!("a:b");
        assert_eq!(
            v.verify(&sign_hs256(b"secret", &odd), NOW),
            Err(AuthError::BadSubject)
        );
        let mut strict = Verifier::hs256(b"secret");
        strict.issuer = Some("https://other.supabase.co/auth/v1".to_owned());
        assert_eq!(strict.verify(&good, NOW), Err(AuthError::WrongIssuer));
        assert_eq!(v.verify("a.b", NOW), Err(AuthError::Malformed));
    }

    #[test]
    fn es256_tokens_verify_against_a_jwks() {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng).unwrap();
        let point = pair.public_key().as_ref();
        let jwks = json!({ "keys": [{ "kty": "EC", "crv": "P-256", "alg": "ES256", "kid": "k1",
            "x": URL_SAFE_NO_PAD.encode(&point[1..33]), "y": URL_SAFE_NO_PAD.encode(&point[33..]) }] });
        let v = Verifier::from_jwks(&jwks.to_string()).unwrap();
        let h = URL_SAFE_NO_PAD.encode(br#"{"alg":"ES256","kid":"k1"}"#);
        let p = URL_SAFE_NO_PAD.encode(claims(NOW / 1000 + 60).to_string());
        let input = format!("{h}.{p}");
        let sig = pair.sign(&rng, input.as_bytes()).unwrap();
        let token = format!("{input}.{}", URL_SAFE_NO_PAD.encode(sig.as_ref()));
        assert!(v.verify(&token, NOW).is_ok());
        // An HS256 token signed with the public key as the secret (alg confusion) finds no key.
        let confused = sign_hs256(point, &claims(NOW / 1000 + 60));
        assert_eq!(v.verify(&confused, NOW), Err(AuthError::UnknownKey));
        let other_kid = format!(
            "{}.{p}.{}",
            URL_SAFE_NO_PAD.encode(br#"{"alg":"ES256","kid":"k2"}"#),
            URL_SAFE_NO_PAD.encode(sig.as_ref())
        );
        assert_eq!(v.verify(&other_kid, NOW), Err(AuthError::UnknownKey));
    }
}
