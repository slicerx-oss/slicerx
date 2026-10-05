// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Shared HTTP plumbing for the REST drivers.
use std::fmt::Write;
use std::time::Duration;

use reqwest::{Client, RequestBuilder, Response, StatusCode};

use crate::error::{Error, Result};
use crate::types::{Image, PrinterConfig};

/// Builds the client for one printer. LAN printers with `tls` on use self-signed
/// certificates, so verification is off for those, and only for those.
pub(crate) fn client(cfg: &PrinterConfig) -> Result<Client> {
    let tls = if cfg.tls.unwrap_or(false) {
        crate::tls::lan_client_config()?
    } else {
        crate::tls::no_trust_config()?
    };
    Client::builder()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(3))
        // The crate links only the `ring` provider, so the TLS config is always explicit.
        .use_preconfigured_tls(rustls::ClientConfig::clone(&tls))
        .build()
        .map_err(|e| Error::Config(e.without_url().to_string()))
}

/// Client for service plugins (Spoolman, Home Assistant). Plain http on the local network
/// only; https to a LAN server would need a trust decision the app does not offer yet.
pub(crate) fn service_client() -> Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(10))
        .use_preconfigured_tls(rustls::ClientConfig::clone(&*crate::tls::no_trust_config()?))
        .build()
        .map_err(|e| Error::Config(e.without_url().to_string()))
}

/// True when something on `host:port` answers like Moonraker: `GET /server/info` returns 200, or
/// 401 or 403 (a key is needed). Two second limit, so probing a closed port is quick.
pub(crate) async fn is_moonraker(cfg: &PrinterConfig, port: u16) -> bool {
    let Ok(client) = client(cfg) else { return false };
    let scheme = if cfg.tls.unwrap_or(false) { "https" } else { "http" };
    let url = format!("{scheme}://{}:{port}/server/info", cfg.host);
    let Ok(r) = client.get(url).timeout(Duration::from_secs(2)).send().await else {
        return false;
    };
    let status = r.status();
    let Ok(body) = r.json::<serde_json::Value>().await else {
        return false;
    };
    if status.is_success() {
        return body.get("result").is_some();
    }
    // Moonraker refuses unknown clients with `{"error": {"code": 401, ...}}`.
    matches!(status.as_u16(), 401 | 403)
        && body
            .get("error")
            .and_then(|e| e.get("code"))
            .and_then(serde_json::Value::as_u64)
            == Some(u64::from(status.as_u16()))
}

/// Reads the first complete JPEG frame from an MJPEG stream, giving up after five seconds or
/// eight megabytes.
pub(crate) async fn mjpeg_frame(client: &Client, url: &str) -> Option<Image> {
    use futures::StreamExt;
    let fut = async {
        let resp = client.get(url).send().await.ok()?;
        let mut stream = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = stream.next().await {
            buf.extend_from_slice(&chunk.ok()?);
            if buf.len() > 8 * 1024 * 1024 {
                return None;
            }
            let start = buf.windows(2).position(|w| w == [0xff, 0xd8])?;
            if let Some(rel) = buf.get(start..)?.windows(2).position(|w| w == [0xff, 0xd9]) {
                return buf.get(start..start + rel + 2).map(<[u8]>::to_vec);
            }
        }
        None
    };
    let data = tokio::time::timeout(Duration::from_secs(5), fut).await.ok()??;
    Some(Image {
        content_type: "image/jpeg".to_owned(),
        data,
    })
}

/// True when `url` is an http(s) URL for exactly `host`. Printers report camera URLs; a
/// compromised one must not point the app at some other machine.
pub(crate) fn same_host(url: &str, host: &str) -> bool {
    let Some(rest) = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
    else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return false;
    }
    let h = match authority.rsplit_once(':') {
        Some((h, port)) if port.bytes().all(|c| c.is_ascii_digit()) => h,
        _ => authority,
    };
    h.trim_matches(['[', ']']).eq_ignore_ascii_case(host)
}

pub(crate) fn base_url(cfg: &PrinterConfig, default_port: u16) -> String {
    let scheme = if cfg.tls.unwrap_or(false) { "https" } else { "http" };
    format!("{scheme}://{}:{}", cfg.host, cfg.port.unwrap_or(default_port))
}

/// Sends a request and maps transport errors and bad statuses to [`Error`]. Error text never
/// includes the URL, which could carry a query string.
pub(crate) async fn send(printer: &str, rb: RequestBuilder) -> Result<Response> {
    let resp = rb
        .send()
        .await
        .map_err(|e| Error::unreachable(printer, e.without_url()))?;
    check(printer, resp)
}

pub(crate) fn check(printer: &str, resp: Response) -> Result<Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(Error::Auth {
            printer: printer.to_owned(),
        }),
        StatusCode::NOT_FOUND => Err(Error::NotFound {
            printer: printer.to_owned(),
            what: "resource".to_owned(),
        }),
        StatusCode::CONFLICT => Err(Error::BadState {
            printer: printer.to_owned(),
            state: "busy or not connected".to_owned(),
            action: "complete the request".to_owned(),
        }),
        s => Err(Error::protocol(printer, format!("HTTP {}", s.as_u16()))),
    }
}

/// The largest JSON reply read from a printer. File lists and object outlines are the largest
/// replies; anything past this is a broken or hostile device.
pub(crate) const MAX_JSON: usize = 8 * 1024 * 1024;

pub(crate) async fn json(printer: &str, mut resp: Response) -> Result<serde_json::Value> {
    if resp.content_length().is_some_and(|n| n > MAX_JSON as u64) {
        return Err(Error::protocol(printer, "the reply is too large"));
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| Error::protocol(printer, e.without_url()))?
    {
        if body.len() + chunk.len() > MAX_JSON {
            return Err(Error::protocol(printer, "the reply is too large"));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|e| Error::protocol(printer, e))
}

/// Percent-encodes one path segment.
/// A GET's JSON body, or `None` on any failure. For optional reads such as the hardware a printer
/// reports at setup.
pub(crate) async fn get_json(printer: &str, rb: RequestBuilder) -> Option<serde_json::Value> {
    json(printer, send(printer, rb).await.ok()?).await.ok()
}

pub(crate) fn seg(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(b));
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

pub(crate) fn f64_at(v: &serde_json::Value, path: &[&str]) -> Option<f64> {
    let mut cur = v;
    for p in path {
        cur = cur.get(*p)?;
    }
    cur.as_f64()
}

pub(crate) fn str_at<'a>(v: &'a serde_json::Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = v;
    for p in path {
        cur = cur.get(*p)?;
    }
    cur.as_str()
}

#[cfg(test)]
mod tests {
    use super::same_host;

    #[test]
    fn same_host_rejects_other_machines() {
        assert!(same_host(
            "http://192.168.1.20:8080/webcam/?action=snapshot",
            "192.168.1.20"
        ));
        assert!(same_host("https://Voron.local/cam", "voron.local"));
        assert!(!same_host("http://evil.example/cam", "192.168.1.20"));
        assert!(!same_host("http://192.168.1.20@evil.example/cam", "192.168.1.20"));
        assert!(!same_host("http://192.168.1.20.evil.example/", "192.168.1.20"));
        assert!(!same_host("ftp://192.168.1.20/", "192.168.1.20"));
    }
}
