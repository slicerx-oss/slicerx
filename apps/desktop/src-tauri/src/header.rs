// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Text the webview sends in an IPC request header. Header values take only Latin-1 in the webview
//! and visible ASCII in [`tauri::http::HeaderValue::to_str`], so names go percent-encoded, as
//! `encodeURIComponent` encodes them, and are decoded here.
use tauri::ipc::Request;

/// The decoded text of header `key`, or `None` when the request has none.
pub fn text(request: &Request<'_>, key: &str) -> Option<String> {
    request
        .headers()
        .get(key)
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
}

/// Undoes `encodeURIComponent`; text that is not a valid escape stays as it is.
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| char::from(c).to_digit(16);
        if b[i] == b'%'
            && i + 2 < b.len()
            && let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2]))
        {
            out.push(u8::try_from(h * 16 + l).unwrap_or(b'?'));
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_come_back_as_the_webview_encoded_them() {
        // encodeURIComponent of each name, as the webview sends it.
        for (sent, name) in [
            ("%D0%9A%D1%83%D0%B1%D0%B8%D0%BA.stl", "Кубик.stl"),
            ("%E7%AB%8B%E6%96%B9%E4%BD%93.3mf", "立方体.3mf"),
            ("W%C3%BCrfel%202.3mf", "Würfel 2.3mf"),
            ("plain.stl", "plain.stl"),
            ("100%25.gcode", "100%.gcode"),
        ] {
            assert_eq!(percent_decode(sent), name);
        }
        assert_eq!(percent_decode("100%"), "100%");
    }
}
