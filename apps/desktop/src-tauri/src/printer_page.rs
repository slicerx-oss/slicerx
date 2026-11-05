// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Opens a printer's own web page (Mainsail, Fluidd, OctoPrint, Duet Web Control, PrusaLink) in the system browser.
//! The page builds the address from the saved printer (`printerWebUi` in @slicerx/printer-catalog); the shell opens
//! it only when it is a plain http or https address on the local network, by the rule the bridge applies before it
//! connects a printer (`sx_link::is_lan_host`, which also refuses a name a browser reads as an IPv4 number). The
//! opener's own allow list takes fixed pages only, and a glob that took every local address would also take
//! `http://10.example.com/`, so these go through here instead.

/// Opens `url` in the browser when it is a printer page on the local network.
#[tauri::command]
pub fn printer_page_open(url: String) -> Result<(), String> {
    open_with(&url, |u| {
        tauri_plugin_opener::open_url(u, None::<&str>).map_err(|e| e.to_string())
    })
}

/// Hands `url` to `open` when [`printer_page`] accepts it.
pub fn open_with(url: &str, open: impl FnOnce(&str) -> Result<(), String>) -> Result<(), String> {
    if !printer_page(url) {
        return Err("only a printer's own page on the local network opens here".into());
    }
    open(url)
}

/// True for `http://host[:port]/path` or the https form, with no user name, query or fragment, whose host is on the
/// local network.
pub fn printer_page(url: &str) -> bool {
    let Some(rest) = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
    else {
        return false;
    };
    let (authority, path) = rest.find('/').map_or((rest, ""), |i| rest.split_at(i));
    if authority.is_empty()
        || authority.contains('@')
        || !path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~/".contains(&b))
    {
        return false;
    }
    let host = if let Some(v6) = authority.strip_prefix('[') {
        let Some((h, after)) = v6.split_once(']') else {
            return false;
        };
        // Brackets hold an IPv6 address and nothing else.
        if h.parse::<std::net::Ipv6Addr>().is_err()
            || !(after.is_empty() || after.strip_prefix(':').is_some_and(valid_port))
        {
            return false;
        }
        h
    } else {
        match authority.split_once(':') {
            Some((h, port)) if valid_port(port) => h,
            Some(_) => return false,
            None => authority,
        }
    };
    !host.contains('%') && sx_link::is_lan_host(host) && !root_tld(host)
}

/// The top-level domains of the DNS root zone, from the printer catalog's list (one file for the app and the shell).
fn root_tlds() -> &'static std::collections::HashSet<&'static str> {
    static SET: std::sync::OnceLock<std::collections::HashSet<&'static str>> = std::sync::OnceLock::new();
    SET.get_or_init(|| {
        let file = include_str!("../../../../packages/connect/catalog/src/root-tlds.ts");
        file.split('`')
            .nth(1)
            .unwrap_or_default()
            .split_whitespace()
            .collect()
    })
}

/// A single label that is a root-zone TLD, such as `ai`: it can resolve on the internet, so it gets no page.
fn root_tld(host: &str) -> bool {
    let h = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
    !h.contains('.') && root_tlds().contains(h.as_str())
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
            open_with(ok, |u| {
                got = Some(u.to_owned());
                Ok(())
            })
            .unwrap();
            assert_eq!(got.as_deref(), Some(ok));
        }
    }

    /// The single labels the app links to and the root-zone TLDs it does not, from the table the app's rule runs too.
    #[test]
    fn single_labels_follow_the_shared_table() {
        let table: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/connect/fixtures/lan-hosts.json"
        ))
        .unwrap();
        for (key, want) in [("allowed", true), ("refused", false)] {
            for h in table["webLink"][key].as_array().unwrap() {
                let url = format!("http://{}/", h.as_str().unwrap());
                assert_eq!(printer_page(&url), want, "{url}");
            }
        }
        assert!(root_tlds().len() > 1400);
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
            "http://ai/",
            "http://COM./",
        ] {
            assert!(
                open_with(bad, |_| panic!("{bad} reached the opener")).is_err(),
                "{bad}"
            );
        }
    }
}
