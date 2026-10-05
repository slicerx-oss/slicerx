// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Which routes a connection may use. Same rules as `routeAllowed` in `packages/pair/src/relay.ts`.

/// Opaque routes are exactly this long: 32 bytes of base64url.
pub const ROUTE_CHARS: usize = 43;

fn b64url(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'-'
}

/// A 43 character base64url capability, open to anyone who knows it.
pub fn is_opaque(route: &str) -> bool {
    route.len() == ROUTE_CHARS && route.bytes().all(b64url)
}

/// The account id of an `acct:<id>:join` route (with up to two 22 character suffixes), if it is one.
pub fn account_of(route: &str) -> Option<&str> {
    let rest = route.strip_prefix("acct:")?;
    let (id, tail) = rest.split_once(':')?;
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return None;
    }
    let tail = tail.strip_prefix("join")?;
    let mut parts = 0;
    let mut t = tail;
    while !t.is_empty() {
        let s = t.strip_prefix(':')?;
        let (seg, next) = s.split_at_checked(22)?;
        if !seg.bytes().all(b64url) {
            return None;
        }
        parts += 1;
        if parts > 2 {
            return None;
        }
        t = next;
    }
    Some(id)
}

/// Opaque routes for everyone; `acct:` routes only for a connection signed in as that account.
pub fn allowed(route: &str, account: Option<&str>) -> bool {
    if is_opaque(route) {
        return true;
    }
    matches!((account_of(route), account), (Some(a), Some(b)) if a == b)
}

#[cfg(test)]
mod tests {
    use super::*;

    const R: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const S: &str = "abcdefghijklmnopqrstuv";

    #[test]
    fn opaque_routes_are_43_base64url_characters() {
        assert!(allowed(R, None));
        assert!(!allowed(&R[1..], None));
        assert!(!allowed(&format!("{R}A"), None));
        assert!(!allowed(&format!("{}=", &R[1..]), None));
    }

    #[test]
    fn account_routes_need_that_account() {
        let base = "acct:user-1:join";
        assert!(!allowed(base, None));
        assert!(!allowed(base, Some("user-2")));
        assert!(allowed(base, Some("user-1")));
        assert!(allowed(&format!("{base}:{S}"), Some("user-1")));
        assert!(allowed(&format!("{base}:{S}:{S}"), Some("user-1")));
        assert!(!allowed(&format!("{base}:{S}:{S}:{S}"), Some("user-1")));
        assert!(!allowed(&format!("{base}:{}", &S[1..]), Some("user-1")));
        assert!(!allowed("acct:user_1:join", Some("user_1")));
        assert!(!allowed("acct:user-1:joins", Some("user-1")));
        assert!(!allowed("acct::join", Some("")));
    }
}
