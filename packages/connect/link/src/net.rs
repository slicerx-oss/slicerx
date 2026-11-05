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
/// meant for it (`*.local`, `*.lan`, `*.home.arpa`, single label). A single label resolves through the
/// local search domain, but a root-zone TLD such as `ai` can resolve on the internet, so the link
/// to a printer's own page refuses those too (`printer_page.rs` in the desktop shell). The bridge refuses to connect
/// printers anywhere else, so a paired page cannot use it to reach the internet. A name a URL
/// parser reads as an IPv4 number is refused too (`134744072` and `0x08080808` are 8.8.8.8 in a
/// browser), as is an address with a leading zero, which the parse below refuses and a browser
/// reads as octal. `@slicerx/printer-catalog`'s `isLanHost` is the same rule; both are tested
/// against `packages/connect/fixtures/lan-hosts.json`.
pub fn is_lan_host(host: &str) -> bool {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => lan_v4(v4),
            IpAddr::V6(v6) => lan_v6(v6),
        };
    }
    // One trailing dot, as a URL parser drops it; `printer..` is not a name.
    let h = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
    if h.is_empty()
        || h.len() > 253
        || !h
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
    {
        return false;
    }
    if ends_in_a_number(&h) {
        return false;
    }
    // `h` is lowercased above and these are DNS suffixes, not file extensions.
    #[allow(clippy::case_sensitive_file_extension_comparisons)]
    let local_suffix = h.ends_with(".local") || h.ends_with(".lan") || h.ends_with(".home.arpa");
    !h.contains('.') || local_suffix
}

/// The URL standard's "ends in a number" test: a host whose last label is digits, or `0x` and hex
/// digits, is parsed as an IPv4 address, whatever the labels before it say.
fn ends_in_a_number(h: &str) -> bool {
    let last = h.rsplit('.').next().unwrap_or_default();
    let hex = last.strip_prefix("0x").or_else(|| last.strip_prefix("0X"));
    (!last.is_empty() && last.bytes().all(|b| b.is_ascii_digit()))
        || hex.is_some_and(|x| x.bytes().all(|b| b.is_ascii_hexdigit()))
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

    /// The hosts both this rule and the printer catalog's `isLanHost` are tested against.
    #[test]
    fn lan_hosts() {
        let table: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/lan-hosts.json")).unwrap();
        let list = |k: &str| -> Vec<String> {
            table[k]
                .as_array()
                .unwrap()
                .iter()
                .map(|h| h.as_str().unwrap().to_owned())
                .collect()
        };
        for ok in list("lan") {
            assert!(is_lan_host(&ok), "{ok}");
        }
        for bad in list("notLan") {
            assert!(!is_lan_host(&bad), "{bad}");
        }
    }
}
