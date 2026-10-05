// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! ONVIF cameras: WS-Discovery to find them, and the device and media services to ask a camera for
//! its RTSP address. Only what a viewer needs: `Probe`, `GetCapabilities`, `GetProfiles` and
//! `GetStreamUri`, with the WS-Security `UsernameToken` digest that cameras ask for.
//! The XML is read by looking for named elements, not by a parser: replies are small and flat, and
//! cameras differ in prefixes and layout.
use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;

use reqwest::Client;
use sha1::{Digest, Sha1};
use tokio::net::UdpSocket;

use crate::rtsp::b64_encode;

pub const DISCOVERY_PORT: u16 = 3702;
pub const DISCOVERY_GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 250);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnvifCamera {
    /// The device service URL the camera announced.
    pub xaddr: String,
    pub host: String,
    pub port: u16,
    pub name: Option<String>,
    pub hardware: Option<String>,
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0_u8; n];
    let _ = getrandom::fill(&mut b);
    crate::types::hex(&b)
}

pub fn probe_message() -> String {
    let id = random_hex(16);
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><e:Envelope xmlns:e=\"http://www.w3.org/2003/05/soap-envelope\" \
xmlns:w=\"http://schemas.xmlsoap.org/ws/2004/08/addressing\" xmlns:d=\"http://schemas.xmlsoap.org/ws/2005/04/discovery\" \
xmlns:dn=\"http://www.onvif.org/ver10/network/wsdl\"><e:Header><w:MessageID>uuid:{id}</w:MessageID>\
<w:To e:mustUnderstand=\"true\">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>\
<w:Action e:mustUnderstand=\"true\">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>\
<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>"
    )
}

/// The text of the first element called `local`, whatever its namespace prefix.
pub(crate) fn tag_text<'a>(xml: &'a str, local: &str) -> Option<&'a str> {
    tag_text_from(xml, local, 0)
}

fn tag_text_from<'a>(xml: &'a str, local: &str, from: usize) -> Option<&'a str> {
    let hay = xml.get(from..)?;
    let mut search = 0;
    while let Some(i) = hay.get(search..)?.find(local) {
        let at = search + i;
        let before = hay.get(..at)?;
        let after = hay.get(at + local.len()..)?;
        // `<local>`, `<local attr=..>` or `<prefix:local>`.
        let opens = before.ends_with('<')
            || (before.ends_with(':')
                && before
                    .rsplit_once('<')
                    .is_some_and(|(_, p)| !p.contains(['>', ' '])));
        if opens && (after.starts_with('>') || after.starts_with(' ')) {
            let body = after.get(after.find('>')? + 1..)?;
            let end = body.find("</")?;
            return body.get(..end);
        }
        search = at + local.len();
    }
    None
}

/// Unescapes the five XML entities.
pub(crate) fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn host_port(url: &str) -> Option<(String, u16)> {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.contains('@') {
        return None;
    }
    let default = if url.starts_with("https") { 443 } else { 80 };
    match authority.rsplit_once(':') {
        Some((h, p)) if p.bytes().all(|b| b.is_ascii_digit()) && !p.is_empty() => {
            Some((h.trim_matches(['[', ']']).to_owned(), p.parse().ok()?))
        }
        _ => Some((authority.to_owned(), default)),
    }
}

/// A ProbeMatches reply. The device service is the first `http` address, preferring an IPv4 one.
pub fn parse_probe_match(xml: &str) -> Option<OnvifCamera> {
    let addrs = tag_text(xml, "XAddrs")?;
    let xaddr = addrs
        .split_whitespace()
        .filter(|a| a.starts_with("http://") || a.starts_with("https://"))
        .find(|a| host_port(a).is_some_and(|(h, _)| h.parse::<Ipv4Addr>().is_ok()))
        .or_else(|| addrs.split_whitespace().find(|a| a.starts_with("http")))?
        .to_owned();
    let (host, port) = host_port(&xaddr)?;
    let scopes = tag_text(xml, "Scopes").unwrap_or("");
    let scope = |key: &str| {
        scopes
            .split_whitespace()
            .find_map(|s| s.split_once(&format!("/{key}/")).map(|(_, v)| v))
            .map(|v| v.replace("%20", " "))
    };
    Some(OnvifCamera {
        xaddr,
        host,
        port,
        name: scope("name"),
        hardware: scope("hardware"),
    })
}

/// Sends a WS-Discovery probe to `target` (the multicast group in production) and collects the
/// cameras that answer within `window`.
pub async fn discover(target: SocketAddr, window: Duration) -> Vec<OnvifCamera> {
    // A loopback target (tests) gets a loopback socket, so the OS firewall has nothing to ask.
    let bind = if target.ip().is_loopback() {
        target.ip()
    } else {
        Ipv4Addr::UNSPECIFIED.into()
    };
    let Ok(sock) = UdpSocket::bind((bind, 0)).await else {
        return Vec::new();
    };
    let msg = probe_message();
    let end = tokio::time::Instant::now() + window;
    let mut next = tokio::time::Instant::now();
    let mut out: Vec<OnvifCamera> = Vec::new();
    let mut buf = vec![0_u8; 16 * 1024];
    while tokio::time::Instant::now() < end {
        if tokio::time::Instant::now() >= next {
            let _ = sock.send_to(msg.as_bytes(), target).await;
            next += (window / 3).max(Duration::from_millis(100));
        }
        if let Ok(Ok((n, _))) = tokio::time::timeout_at(next.min(end), sock.recv_from(&mut buf)).await
            && let Some(cam) = buf
                .get(..n)
                .and_then(|d| std::str::from_utf8(d).ok())
                .and_then(parse_probe_match)
            && !out.iter().any(|c| c.xaddr == cam.xaddr)
        {
            out.push(cam);
        }
    }
    out
}

/// The `Security` header with a `UsernameToken` digest: `base64(sha1(nonce + created + password))`.
pub(crate) fn security_header(user: &str, password: &str, nonce: &[u8], created: &str) -> String {
    let mut h = Sha1::new();
    h.update(nonce);
    h.update(created.as_bytes());
    h.update(password.as_bytes());
    let digest = b64_encode(&h.finalize());
    format!(
        "<s:Header><wsse:Security s:mustUnderstand=\"1\" \
xmlns:wsse=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd\" \
xmlns:wsu=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd\"><wsse:UsernameToken>\
<wsse:Username>{}</wsse:Username>\
<wsse:Password Type=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest\">{digest}</wsse:Password>\
<wsse:Nonce EncodingType=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary\">{}</wsse:Nonce>\
<wsu:Created>{created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>",
        escape(user),
        b64_encode(nonce)
    )
}

async fn soap(
    client: &Client,
    url: &str,
    login: Option<&(String, String)>,
    ns: &str,
    body: &str,
) -> Option<String> {
    let header = match login {
        Some((u, p)) => {
            let mut nonce = [0_u8; 16];
            getrandom::fill(&mut nonce).ok()?;
            security_header(u, p, &nonce, &crate::types::now_iso())
        }
        None => String::new(),
    };
    let envelope = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><s:Envelope xmlns:s=\"http://www.w3.org/2003/05/soap-envelope\" \
xmlns:tds=\"http://www.onvif.org/ver10/device/wsdl\" xmlns:trt=\"http://www.onvif.org/ver10/media/wsdl\" \
xmlns:tt=\"http://www.onvif.org/ver10/schema\">{header}<s:Body>{body}</s:Body></s:Envelope>"
    );
    let _ = ns;
    let resp = client
        .post(url)
        .header("content-type", "application/soap+xml; charset=utf-8")
        .body(envelope)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    // A SOAP fault can arrive with status 200.
    (!text.contains("Fault>")).then_some(text)
}

/// Asks the camera at `device_service` for its RTSP address: the media service from
/// `GetCapabilities`, the first H.264 profile (else the first profile) from `GetProfiles`, then
/// `GetStreamUri`. The address the camera reports is used only for its path: the host is always the
/// one the camera was reached at, so a wrong or hostile answer cannot point the app elsewhere.
pub async fn stream_uri(
    client: &Client,
    device_service: &str,
    login: Option<&(String, String)>,
) -> Option<String> {
    let (host, _) = host_port(device_service)?;
    let caps = soap(
        client,
        device_service,
        login,
        "tds",
        "<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>",
    )
    .await;
    let media_url = caps
        .as_deref()
        .and_then(|c| {
            let at = c.find("Media>")?;
            tag_text_from(c, "XAddr", at)
        })
        .map(unescape)
        .filter(|u| host_port(u).is_some_and(|(h, _)| h == host))
        .unwrap_or_else(|| device_service.replace("device_service", "media_service"));
    let profiles = soap(client, &media_url, login, "trt", "<trt:GetProfiles/>").await?;
    let sections: Vec<&str> = profiles.split("Profiles ").skip(1).collect();
    let token_of = |s: &str| -> Option<String> {
        let t = s.split_once("token=\"")?.1;
        Some(t.split_once('"')?.0.to_owned())
    };
    let token = sections
        .iter()
        .find(|s| s.contains("H264") || s.contains("h264"))
        .or_else(|| sections.first())
        .and_then(|s| token_of(s))?;
    let body = format!(
        "<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>{}</trt:ProfileToken></trt:GetStreamUri>",
        escape(&token)
    );
    let reply = soap(client, &media_url, login, "trt", &body).await?;
    let uri = unescape(tag_text(&reply, "Uri")?.trim());
    rewrite_rtsp_host(&uri, &host)
}

/// `rtsp://user@other:554/path` becomes `rtsp://HOST:554/path`: no login, and the camera's own host.
pub(crate) fn rewrite_rtsp_host(uri: &str, host: &str) -> Option<String> {
    let (scheme, rest) = uri.split_once("://")?;
    if scheme != "rtsp" && scheme != "rtsps" {
        return None;
    }
    let (authority, path) = match rest.find('/') {
        Some(i) => (rest.get(..i)?, rest.get(i..)?),
        None => (rest, ""),
    };
    let authority = authority.rsplit_once('@').map_or(authority, |(_, a)| a);
    let port = match authority.rsplit_once(':') {
        Some((_, p)) if p.bytes().all(|b| b.is_ascii_digit()) && !p.is_empty() => format!(":{p}"),
        _ => String::new(),
    };
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    Some(format!("{scheme}://{host}{port}{path}"))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn elements_are_found_whatever_the_prefix() {
        assert_eq!(tag_text("<a:Uri>rtsp://x</a:Uri>", "Uri"), Some("rtsp://x"));
        assert_eq!(tag_text("<Uri>rtsp://x</Uri>", "Uri"), Some("rtsp://x"));
        assert_eq!(tag_text("<tt:Uri attr=\"1\">y</tt:Uri>", "Uri"), Some("y"));
        assert_eq!(tag_text("<tt:UriList>y</tt:UriList>", "Uri"), None);
        assert_eq!(tag_text("<x/>", "Uri"), None);
    }

    #[test]
    fn a_probe_match_gives_the_device_service_name_and_hardware() {
        let xml = "<d:ProbeMatches><d:ProbeMatch><d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/Porch%20Cam onvif://www.onvif.org/hardware/IPC-1</d:Scopes>\
<d:XAddrs>http://[fe80::1]:80/onvif/device_service http://192.168.1.60:8080/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches>";
        let c = parse_probe_match(xml).unwrap();
        assert_eq!(c.xaddr, "http://192.168.1.60:8080/onvif/device_service");
        assert_eq!((c.host.as_str(), c.port), ("192.168.1.60", 8080));
        assert_eq!(c.name.as_deref(), Some("Porch Cam"));
        assert_eq!(c.hardware.as_deref(), Some("IPC-1"));
        assert!(parse_probe_match("<x/>").is_none());
        assert!(parse_probe_match("<XAddrs>ftp://x</XAddrs>").is_none());
    }

    #[test]
    fn the_username_token_digest_is_base64_of_sha1_of_nonce_created_password() {
        // Expected value computed separately with Python's hashlib for these inputs.
        let nonce = crate::rtsp::b64_decode("LKqI6G/AikKCQrN0zqZFlg==").unwrap();
        let h = security_header("user", "taadtaadpstcsm", &nonce, "2010-09-16T07:50:45Z");
        assert!(h.contains(">4yw0wCaNY3YRjgmVN3nmKpEImu8=</wsse:Password>"), "{h}");
        assert!(security_header("a<b", "p", &nonce, "t").contains("a&lt;b"));
    }

    #[test]
    fn the_camera_host_wins_over_what_it_reports() {
        assert_eq!(
            rewrite_rtsp_host("rtsp://admin:pw@10.9.9.9:554/stream1?x=1", "192.168.1.60").as_deref(),
            Some("rtsp://192.168.1.60:554/stream1?x=1")
        );
        assert_eq!(
            rewrite_rtsp_host("rtsp://cam/live", "192.168.1.60").as_deref(),
            Some("rtsp://192.168.1.60/live")
        );
        assert!(rewrite_rtsp_host("http://cam/live", "h").is_none());
    }
}
