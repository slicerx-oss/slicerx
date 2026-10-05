// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Origins a browser may connect from: the hosted app, localhost dev servers, and the Tauri
/// webview. A page on any other origin is refused before the WebSocket opens, so a random
/// website cannot even attempt the pairing code.
pub fn origin_allowed(origin: &str, extra: &[String]) -> bool {
    const FIXED: &[&str] = &[
        "https://slicerx.app",
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ];
    if FIXED.contains(&origin) || extra.iter().any(|e| e == origin) {
        return true;
    }
    // http://localhost or http://127.0.0.1 with an optional port and nothing else.
    for base in ["http://localhost", "http://127.0.0.1"] {
        if let Some(rest) = origin.strip_prefix(base) {
            return rest.is_empty()
                || rest
                    .strip_prefix(':')
                    .is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
        }
    }
    false
}

/// True for hosts on the local network: private and loopback IP ranges, link-local, and names
/// that cannot resolve outside it (`*.local`, single label). The bridge refuses to connect
/// printers anywhere else, so a paired page cannot use it to reach the internet.
pub fn is_lan_host(host: &str) -> bool {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => lan_v4(v4),
            IpAddr::V6(v6) => lan_v6(v6),
        };
    }
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    if h.is_empty()
        || h.len() > 253
        || !h
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
    {
        return false;
    }
    // `h` is lowercased above and these are DNS suffixes, not file extensions.
    #[allow(clippy::case_sensitive_file_extension_comparisons)]
    let local_suffix = h.ends_with(".local") || h.ends_with(".lan") || h.ends_with(".home.arpa");
    !h.contains('.') || local_suffix
}

fn lan_v4(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_loopback() || ip.is_link_local()
}

fn lan_v6(ip: Ipv6Addr) -> bool {
    let seg = ip.segments();
    ip.is_loopback() || (seg[0] & 0xfe00) == 0xfc00 || (seg[0] & 0xffc0) == 0xfe80
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins() {
        for ok in [
            "https://slicerx.app",
            "http://localhost:5173",
            "http://127.0.0.1",
            "http://localhost",
            "tauri://localhost",
        ] {
            assert!(origin_allowed(ok, &[]), "{ok}");
        }
        for bad in [
            "https://evil.example",
            "http://slicerx.app",
            "https://slicerx.app.evil.example",
            "http://localhost.evil.example",
            "http://localhost:",
            "http://127.0.0.1.evil.example",
            "null",
            "",
        ] {
            assert!(!origin_allowed(bad, &[]), "{bad}");
        }
        assert!(origin_allowed(
            "https://staging.example",
            &["https://staging.example".to_owned()]
        ));
    }

    #[test]
    fn lan_hosts() {
        for ok in [
            "192.168.1.20",
            "10.0.0.5",
            "172.16.4.4",
            "127.0.0.1",
            "169.254.1.1",
            "voron.local",
            "printer",
            "::1",
            "fd00::5",
            "fe80::1",
            "bay-1.lan",
        ] {
            assert!(is_lan_host(ok), "{ok}");
        }
        for bad in [
            "8.8.8.8",
            "172.32.0.1",
            "example.com",
            "printer.example.org",
            "2001:db8::1",
            "",
            "a b",
            "192.168.1.1/x",
            "user@host",
        ] {
            assert!(!is_lan_host(bad), "{bad}");
        }
    }
}
