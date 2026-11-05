// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Opens a printer's own web page (Mainsail, Fluidd, OctoPrint, Duet Web Control, PrusaLink) in the system browser.
//! The page builds the address from the saved printer (`printerWebUi` in @slicerx/printer-catalog); the shell opens
//! it only when it is a plain http or https address on the local network, by the rule the bridge applies before it
//! connects a printer (`sx_link::is_lan_host`). The opener's own allow list takes fixed pages only, and a glob that
//! took every local address would also take `http://10.example.com/`, so these go through here instead.

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
        if !(after.is_empty() || after.strip_prefix(':').is_some_and(valid_port)) {
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
    !host.contains('%') && sx_link::is_lan_host(host)
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
        ] {
            assert!(
                open_with(bad, |_| panic!("{bad} reached the opener")).is_err(),
                "{bad}"
            );
        }
    }
}
