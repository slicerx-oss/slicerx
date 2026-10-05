// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The computer's own network interfaces, for discovery that has to go out on each of them. A
//! socket bound to 0.0.0.0 sends multicast and 255.255.255.255 out of one interface only, the one
//! the OS picks; on Windows with Hyper-V or WSL that is often a virtual adapter and the printer never
//! hears the question.
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};

use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::UdpSocket;

/// One IPv4 interface that is up and on a private network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LanV4 {
    pub ip: Ipv4Addr,
    /// The subnet's directed broadcast (192.168.71.255 for 192.168.68.60/22).
    pub broadcast: Ipv4Addr,
}

/// Private IPv4 interfaces that are up. Loopback, link-local and point to point links (VPN
/// tunnels) are left out.
pub fn lan_v4() -> Vec<LanV4> {
    let Ok(all) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    let mut out: Vec<LanV4> = all
        .into_iter()
        .filter(|i| !i.is_loopback() && !i.is_p2p() && i.is_oper_up())
        .filter_map(|i| match i.addr {
            if_addrs::IfAddr::V4(a) if a.ip.is_private() => Some(LanV4 {
                ip: a.ip,
                broadcast: a.broadcast.unwrap_or_else(|| directed_broadcast(a.ip, a.netmask)),
            }),
            _ => None,
        })
        .collect();
    out.sort_by_key(|l| l.ip);
    out.dedup();
    out
}

pub fn directed_broadcast(ip: Ipv4Addr, mask: Ipv4Addr) -> Ipv4Addr {
    Ipv4Addr::from(u32::from(ip) | !u32::from(mask))
}

/// A UDP socket on `bind` that may send broadcasts, with multicast going out of `bind`'s interface.
pub fn sender(bind: Ipv4Addr) -> std::io::Result<UdpSocket> {
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    s.set_broadcast(true)?;
    if !bind.is_unspecified() && !bind.is_loopback() {
        s.set_multicast_if_v4(&bind)?;
    }
    s.set_nonblocking(true)?;
    s.bind(&SocketAddr::V4(SocketAddrV4::new(bind, 0)).into())?;
    UdpSocket::from_std(s.into())
}

/// A UDP socket on a fixed port that shares the port with other programs (Bambu Studio and
/// OrcaSlicer listen on the same ones), so broadcasts reach both.
pub fn shared_listener(bind: Ipv4Addr, port: u16) -> std::io::Result<UdpSocket> {
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    s.set_reuse_address(true)?;
    #[cfg(all(unix, not(any(target_os = "solaris", target_os = "illumos"))))]
    s.set_reuse_port(true)?;
    s.set_nonblocking(true)?;
    s.bind(&SocketAddr::V4(SocketAddrV4::new(bind, port)).into())?;
    UdpSocket::from_std(s.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broadcast_of_a_slash_22() {
        assert_eq!(
            directed_broadcast(Ipv4Addr::new(192, 168, 68, 60), Ipv4Addr::new(255, 255, 252, 0)),
            Ipv4Addr::new(192, 168, 71, 255)
        );
    }

    #[tokio::test]
    async fn two_listeners_share_a_port() {
        let a = shared_listener(Ipv4Addr::LOCALHOST, 0).unwrap();
        let port = a.local_addr().unwrap().port();
        assert!(shared_listener(Ipv4Addr::LOCALHOST, port).is_ok());
    }
}
