// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Announces the phone LAN listener over mDNS as `_slicerx._tcp` while it is on, so a phone can
//! find the app without typing an address. The advert says only that an app is here, on which
//! port and addresses. The instance and host names are random, so nothing about the user or the
//! machine leaks, and no pairing secret is ever in it.
use std::fmt::Write as _;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use sx_connect::mdns::{Advert, MDNS_GROUP_V4, MDNS_PORT};
use tokio::net::UdpSocket;
use tokio::task::JoinHandle;

pub const SERVICE: &str = "_slicerx._tcp.local";
/// Replies per second across all askers. Beyond it queries are ignored, so a noisy peer cannot make
/// the bridge answer in a loop.
const REPLIES_PER_SECOND: u32 = 20;

/// Where the advertiser listens and sends. Both are the multicast group in production; tests point
/// them at local sockets.
#[derive(Debug, Clone, Default)]
pub struct MdnsConfig {
    /// Turn off both advertising and browsing (`--no-mdns`).
    pub disabled: bool,
    /// Where `discover` sends its query. Defaults to `224.0.0.251:5353`.
    pub browse_target: Option<SocketAddr>,
    /// Where `cameras.discover` sends its WS-Discovery probe. Defaults to `239.255.255.250:3702`.
    pub onvif_target: Option<SocketAddr>,
    /// Bind the advertiser here instead of `0.0.0.0:5353`, and skip the multicast join (tests).
    pub advert_bind: Option<SocketAddr>,
    /// Send announcements here instead of the multicast group (tests).
    pub advert_to: Option<SocketAddr>,
}

pub(crate) struct Advertiser {
    task: JoinHandle<()>,
    sock: Arc<UdpSocket>,
    advert: Advert,
    to: SocketAddr,
}

fn random_hex(n: usize) -> Option<String> {
    let mut b = vec![0_u8; n];
    getrandom::fill(&mut b).ok()?;
    let mut out = String::new();
    for x in &b {
        let _ = write!(out, "{x:02x}");
    }
    Some(out)
}

fn socket(cfg: &MdnsConfig, addresses: &[Ipv4Addr]) -> std::io::Result<UdpSocket> {
    if let Some(bind) = cfg.advert_bind {
        let s = std::net::UdpSocket::bind(bind)?;
        s.set_nonblocking(true)?;
        return UdpSocket::from_std(s);
    }
    let s = socket2::Socket::new(
        socket2::Domain::IPV4,
        socket2::Type::DGRAM,
        Some(socket2::Protocol::UDP),
    )?;
    s.set_reuse_address(true)?;
    // The system's own responder already owns 5353 on macOS and Linux with Avahi, so share it.
    #[cfg(all(
        unix,
        not(any(target_os = "solaris", target_os = "illumos", target_os = "cygwin"))
    ))]
    s.set_reuse_port(true)?;
    s.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, MDNS_PORT)).into())?;
    s.set_nonblocking(true)?;
    let mut joined = false;
    for a in addresses {
        joined |= s.join_multicast_v4(&MDNS_GROUP_V4, a).is_ok();
    }
    if !joined {
        return Err(std::io::Error::other("no interface accepted the multicast group"));
    }
    UdpSocket::from_std(s.into())
}

impl Advertiser {
    /// Starts advertising `port`. `Err` when there is no private IPv4 address or the socket cannot
    /// be set up; the caller carries on without it.
    pub(crate) fn start(cfg: &MdnsConfig, port: u16, addresses: &[String]) -> std::io::Result<Self> {
        let v4: Vec<Ipv4Addr> = addresses.iter().filter_map(|a| a.parse().ok()).collect();
        let (Some(inst), Some(host)) = (random_hex(2), random_hex(4)) else {
            return Err(std::io::Error::other("no randomness"));
        };
        let advert = Advert {
            service: SERVICE.to_owned(),
            instance: format!("SlicerX-{inst}"),
            host: format!("sx-{host}.local"),
            port,
            addresses: v4.iter().copied().map(IpAddr::V4).collect(),
            txt: vec!["v=1".to_owned()],
        };
        if v4.is_empty() && cfg.advert_bind.is_none() {
            return Err(std::io::Error::other("no private IPv4 address"));
        }
        let sock = Arc::new(socket(cfg, &v4)?);
        let to = cfg
            .advert_to
            .unwrap_or_else(|| SocketAddr::from((MDNS_GROUP_V4, MDNS_PORT)));
        let task = tokio::spawn(run(sock.clone(), advert.clone(), to));
        Ok(Self {
            task,
            sock,
            advert,
            to,
        })
    }

    /// Withdraws the service and stops answering.
    pub(crate) async fn stop(self) {
        self.task.abort();
        let _ = self.sock.send_to(&self.advert.goodbye(), self.to).await;
    }
}

async fn run(sock: Arc<UdpSocket>, advert: Advert, to: SocketAddr) {
    let _ = sock.send_to(&advert.announcement(), to).await;
    let mut announce_again = Box::pin(tokio::time::sleep(Duration::from_secs(1)));
    let mut announced_twice = false;
    let mut window = (tokio::time::Instant::now(), 0_u32);
    let mut buf = vec![0_u8; 9000];
    loop {
        tokio::select! {
            () = &mut announce_again, if !announced_twice => {
                announced_twice = true;
                let _ = sock.send_to(&advert.announcement(), to).await;
            }
            r = sock.recv_from(&mut buf) => {
                let Ok((n, from)) = r else { continue };
                let Some((resp, unicast)) = buf.get(..n).and_then(|p| advert.answer(p)) else { continue };
                let now = tokio::time::Instant::now();
                if now.duration_since(window.0) >= Duration::from_secs(1) {
                    window = (now, 0);
                }
                window.1 += 1;
                if window.1 > REPLIES_PER_SECOND {
                    continue;
                }
                let dest = if unicast || from.port() != MDNS_PORT { from } else { to };
                let _ = sock.send_to(&resp, dest).await;
            }
        }
    }
}
