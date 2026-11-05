// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Opens a printer's own web page (Mainsail, Fluidd, OctoPrint, Duet Web Control, PrusaLink) in the system browser.
//! The page builds the address from the saved printer (`printerWebUi` in @slicerx/printer-catalog); the shell opens
//! it only when it is a plain http or https address on the local network, by the rule the bridge applies before it
//! connects a printer (`sx_link::is_lan_host`, which also refuses a name a browser reads as an IPv4 number). A single
//! label normally resolves through the local search domain, but one that is also a top-level domain (`ai`) could
//! resolve on the internet, so the shell asks the system resolver first and opens it only when every address it gets
//! is local. The opener's own allow list takes fixed pages only, and a glob that took every local address would also
//! take `http://10.example.com/`, so these go through here instead.

use std::net::{IpAddr, ToSocketAddrs};

/// Opens `url` in the browser when it is a printer page on the local network. The lookup of a single-label name
/// runs off the main thread.
#[tauri::command]
pub async fn printer_page_open(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_with(&url, system_resolve, |u| {
            tauri_plugin_opener::open_url(u, None::<&str>).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Hands `url` to `open` when [`page_host`] accepts it and, for a single-label name, every address `resolve` gives
/// is local (and there is at least one).
pub fn open_with(
    url: &str,
    resolve: impl FnOnce(&str) -> Vec<IpAddr>,
    open: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    let Some(host) = page_host(url) else {
        return Err("only a printer's own page on the local network opens here".into());
    };
    let name = host.strip_suffix('.').unwrap_or(host);
    if !name.contains('.') && !name.contains(':') {
        // Every address must be local: a browser may connect to any of them.
        let found = resolve(name);
        if found.is_empty() || !found.iter().all(|ip| sx_link::is_lan_host(&ip.to_string())) {
            return Err(format!(
                "{name} does not resolve only to addresses on the local network"
            ));
        }
    }
    open(url)
}

/// The addresses the system resolver gives for `name`; none when it fails.
fn system_resolve(name: &str) -> Vec<IpAddr> {
    (name, 80)
        .to_socket_addrs()
        .map(|a| a.map(|s| s.ip()).collect())
        .unwrap_or_default()
}

/// The host of `http://host[:port]/path` or the https form, with no user name, query or fragment, when it is on the
/// local network.
pub fn page_host(url: &str) -> Option<&str> {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))?;
    let (authority, path) = rest.find('/').map_or((rest, ""), |i| rest.split_at(i));
    if authority.is_empty()
        || authority.contains('@')
        || !path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~/".contains(&b))
    {
        return None;
    }
    let host = if let Some(v6) = authority.strip_prefix('[') {
        let (h, after) = v6.split_once(']')?;
        // Brackets hold an IPv6 address and nothing else.
        if h.parse::<std::net::Ipv6Addr>().is_err()
            || !(after.is_empty() || after.strip_prefix(':').is_some_and(valid_port))
        {
            return None;
        }
        h
    } else {
        match authority.split_once(':') {
            Some((h, port)) if valid_port(port) => h,
            Some(_) => return None,
            None => authority,
        }
    };
    (!host.contains('%') && sx_link::is_lan_host(host)).then_some(host)
}

fn valid_port(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 5
        && p.bytes().all(|b| b.is_ascii_digit())
        && p.parse::<u16>().is_ok_and(|n| n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn printer_pages_on_the_local_network_open() {
        for ok in [
            "http://192.168.1.20/",
            "http://192.168.1.50:10088/",
            "http://voron.local/",
            "http://octopi.local:5000/",
            "https://10.0.0.7/",
            "http://[fd00::5]:7125/",
            "http://printer/",
            "http://192.168.1.20",
            "http://VORON.LOCAL/",
            "http://voron.local./",
        ] {
            let mut got = None;
            let lan = |_: &str| vec!["192.168.1.2".parse().unwrap()];
            open_with(ok, lan, |u| {
                got = Some(u.to_owned());
                Ok(())
            })
            .unwrap();
            assert_eq!(got.as_deref(), Some(ok));
        }
    }

    /// A single-label name opens only when every address the resolver gives is local; dotted names and addresses are not looked up.
    #[test]
    fn a_single_label_opens_only_when_it_resolves_on_the_network() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let try_open = |url: &str, found: Vec<IpAddr>| open_with(url, move |_| found, |_| Ok(()));
        assert!(try_open("http://octopi/", vec![ip("192.168.1.30")]).is_ok());
        assert!(try_open("http://mini:8080/", vec![ip("8.8.8.8"), ip("fd00::5")]).is_err());
        assert!(
            try_open(
                "http://mini:8080/",
                vec![ip("192.168.1.31"), ip("fd00::5"), ip("fe80::1")]
            )
            .is_ok()
        );
        assert!(try_open("http://ai/", vec![ip("8.8.8.8")]).is_err());
        assert!(try_open("http://octopi./", vec![]).is_err());
        let not_asked = |_: &str| -> Vec<IpAddr> { panic!("looked up a name that needs no lookup") };
        for url in ["http://voron.local/", "http://192.168.1.20/", "http://[fd00::5]/"] {
            assert!(open_with(url, not_asked, |_| Ok(())).is_ok(), "{url}");
        }
        // The real resolver knows localhost.
        assert!(open_with("http://localhost/", system_resolve, |_| Ok(())).is_ok());
    }

    #[test]
    fn anything_else_is_refused_before_the_browser() {
        for bad in [
            "http://8.8.8.8/",
            "http://example.com/",
            "http://10.example.com/",
            "http://192.168.1.5.nip.io/",
            "http://user@192.168.1.20/",
            "http://192.168.1.20@evil.example/",
            "http://192.168.1.20/?next=https://evil.example",
            "http://192.168.1.20/#x",
            "http://192.168.1.20:0/",
            "http://192.168.1.20:99999/",
            "http://192.168.1.20:/",
            "http://[2001:db8::1]/",
            "http://[fe80::1%25en0]/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://192.168.1.20/",
            "http:///",
            "",
            // Names a browser reads as an IPv4 number, and octal octets: each is a public address there.
            "http://134744072/",
            "http://0x08080808/",
            "http://0x7f/",
            "http://01002004010/",
            "http://010/",
            "http://010.0.0.1/",
            "http://8.8.8.8./",
            "http://[::ffff:192.168.1.1]/",
            "http://EVIL.COM/",
            "http://printer../",
            "http://[voron.local]/",
            "http://[127.0.0.1]/",
            "http://0X7F000001/",
            "http://192.168.1.20:80:90/",
            "http://192.168.1.20\\@8.8.8.8/",
            "http://voron.local%2e/",
        ] {
            assert!(
                open_with(bad, |_| Vec::new(), |_| panic!("{bad} reached the opener")).is_err(),
                "{bad}"
            );
        }
    }
}
