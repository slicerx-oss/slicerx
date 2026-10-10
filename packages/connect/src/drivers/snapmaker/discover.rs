// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Snapmaker 2.0, J1 and Artisan discovery: the ASCII string `discover` sent by UDP to port 20054,
//! answered by each machine with one pipe separated line such as
//! `Snapmaker J1@192.168.1.100|model:J1|status:IDLE|SACP:1` (Snapmaker forum, Web API thread;
//! sm2uploader). Key names past the name and address are community knowledge.
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use tokio::net::UdpSocket;

use crate::types::DiscoveredPrinter;

pub(crate) const DISCOVERY_PORT: u16 = 20054;
/// The HTTP API port of the 2.0 machines.
pub(crate) const LUBAN_PORT: u16 = 8080;
/// The SACP port of the J1 and Artisan.
pub(crate) const SACP_PORT: u16 = 8888;

/// One discovery reply. `from` is the address it came from, used when the reply names none.
pub(crate) fn parse_reply(text: &str, from: IpAddr) -> Option<DiscoveredPrinter> {
    let text = text.trim();
    let mut parts = text.split('|');
    let head = parts.next()?.trim();
    let (name, named_ip) = match head.rsplit_once('@') {
        Some((n, ip)) => (n.trim(), ip.trim().parse::<IpAddr>().ok()),
        None => (head, None),
    };
    let mut model = None;
    let mut sacp = false;
    for p in parts {
        let Some((k, v)) = p.split_once(':') else { continue };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
        match k.as_str() {
            "model" if !v.is_empty() => model = Some(v.to_owned()),
            "sacp" => sacp = v == "1" || v.eq_ignore_ascii_case("true"),
            _ => {}
        }
    }
    // A reply must look like one: a name and an address or a model, not any datagram on the port.
    if name.is_empty() || (named_ip.is_none() && model.is_none()) {
        return None;
    }
    let label = model.as_deref().unwrap_or(name).to_ascii_uppercase();
    if label.starts_with("J1") || label.contains("ARTISAN") || name.to_ascii_uppercase().contains("J1") {
        sacp = true;
    }
    Some(DiscoveredPrinter {
        plugin: "snapmaker".to_owned(),
        host: named_ip.unwrap_or(from).to_string(),
        port: Some(if sacp { SACP_PORT } else { LUBAN_PORT }),
        name: Some(name.to_owned()),
        model,
        serial: None,
        firmware: None,
        lan_only: None,
        ..DiscoveredPrinter::default()
    })
}

/// Broadcasts `discover` from each local network (or `bind` alone when it is set) and collects the
/// replies for `window`. Sent once, when the user starts a scan.
pub(crate) async fn broadcast(bind: IpAddr, port: u16, window: Duration) -> Vec<DiscoveredPrinter> {
    let senders: Vec<(IpAddr, Vec<SocketAddr>)> = match bind {
        IpAddr::V4(ip) if ip.is_unspecified() => crate::netif::lan_v4()
            .into_iter()
            .map(|i| {
                (
                    i.ip.into(),
                    vec![(i.broadcast, port).into(), (Ipv4Addr::BROADCAST, port).into()],
                )
            })
            .collect(),
        ip if ip.is_loopback() => vec![(ip, vec![(ip, port).into()])],
        ip => vec![(ip, vec![(Ipv4Addr::BROADCAST, port).into()])],
    };
    let runs = senders.into_iter().map(|(ip, to)| async move {
        let sock = match ip {
            IpAddr::V4(v4) if !v4.is_loopback() => crate::netif::sender(v4).ok(),
            _ => UdpSocket::bind((ip, 0)).await.ok(),
        };
        let Some(sock) = sock else { return Vec::new() };
        ask(&sock, &to, window).await
    });
    let mut found: Vec<DiscoveredPrinter> = Vec::new();
    for p in futures::future::join_all(runs).await.into_iter().flatten() {
        if !found.iter().any(|f| f.host == p.host) {
            found.push(p);
        }
    }
    found
}

/// Sends `discover` to one address from `bind` (all addresses in the app, 127.0.0.1 in tests) and
/// waits for its reply, for a typed IP.
pub(crate) async fn ask_one(
    bind: IpAddr,
    host: Ipv4Addr,
    port: u16,
    window: Duration,
) -> Option<DiscoveredPrinter> {
    let bind = match bind {
        _ if host.is_loopback() => Ipv4Addr::LOCALHOST,
        IpAddr::V4(ip) => ip,
        IpAddr::V6(_) => Ipv4Addr::UNSPECIFIED,
    };
    let sock = UdpSocket::bind((bind, 0)).await.ok()?;
    let mut found = ask(&sock, &[(host, port).into()], window).await;
    let i = found.iter().position(|p| p.host == host.to_string()).unwrap_or(0);
    if found.is_empty() {
        return None;
    }
    let mut p = found.swap_remove(i);
    // The machine may name another of its addresses; the one typed is the one that answered.
    p.host = host.to_string();
    Some(p)
}

/// Sends `discover` to each of `to`, three times across the window because UDP is lossy (the
/// forum notes retry up to five times), and parses every reply.
async fn ask(sock: &UdpSocket, to: &[SocketAddr], window: Duration) -> Vec<DiscoveredPrinter> {
    let end = tokio::time::Instant::now() + window;
    let step = (window / 3).max(Duration::from_millis(50));
    let mut next = tokio::time::Instant::now();
    let mut out = Vec::new();
    let mut buf = vec![0_u8; 2048];
    loop {
        let now = tokio::time::Instant::now();
        if now >= end {
            break;
        }
        if now >= next {
            for t in to {
                let _ = sock.send_to(b"discover", t).await;
            }
            next = now + step;
        }
        if let Ok(Ok((n, from))) = tokio::time::timeout_at(next.min(end), sock.recv_from(&mut buf)).await
            && let Some(p) = buf
                .get(..n)
                .and_then(|d| std::str::from_utf8(d).ok())
                .and_then(|t| parse_reply(t, from.ip()))
            && !out.iter().any(|o: &DiscoveredPrinter| o.host == p.host)
        {
            out.push(p);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_name_the_machine_and_the_protocol() {
        let from: IpAddr = "192.0.2.9".parse().unwrap();
        let a = parse_reply("A350-3DP@192.168.1.100|model:A350|status:IDLE", from).unwrap();
        assert_eq!(a.host, "192.168.1.100");
        assert_eq!((a.model.as_deref(), a.port), (Some("A350"), Some(LUBAN_PORT)));
        let j = parse_reply("Snapmaker-J1@192.168.1.101|model:J1|status:IDLE", from).unwrap();
        assert_eq!(j.port, Some(SACP_PORT));
        let s = parse_reply("Artisan@192.168.1.102|model:Snapmaker Artisan|SACP:1", from).unwrap();
        assert_eq!(s.port, Some(SACP_PORT));
        // No address in the reply: the sender's.
        let n = parse_reply("J1V19|model:J1", from).unwrap();
        assert_eq!(n.host, "192.0.2.9");
        assert!(parse_reply("discover", from).is_none());
        assert!(parse_reply("", from).is_none());
    }

    #[tokio::test]
    async fn a_typed_address_is_asked_alone() {
        let machine = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = machine.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut buf = [0_u8; 64];
            while let Ok((n, from)) = machine.recv_from(&mut buf).await {
                if &buf[..n] == b"discover" {
                    let reply = b"Snapmaker A350@192.0.2.30|model:A350|status:IDLE";
                    machine.send_to(reply, from).await.unwrap();
                }
            }
        });
        let p = ask_one(
            Ipv4Addr::LOCALHOST.into(),
            Ipv4Addr::LOCALHOST,
            port,
            Duration::from_millis(300),
        )
        .await
        .unwrap();
        assert_eq!((p.host.as_str(), p.model.as_deref()), ("127.0.0.1", Some("A350")));
        let all = broadcast(Ipv4Addr::LOCALHOST.into(), port, Duration::from_millis(300)).await;
        assert_eq!(all.len(), 1);
    }
}
