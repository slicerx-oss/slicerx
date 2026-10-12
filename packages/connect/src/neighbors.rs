// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The computer's neighbour table (ARP): the addresses on the local network it has talked to lately,
//! with their hardware (MAC) addresses. A printer that announces nothing can still be found by the
//! maker's MAC prefix there: Prusa's network modules start with 10:9C:70. Read-only and quiet: it asks
//! the operating system, never the network, so a printer the computer has not talked to lately is
//! not in it.
use std::net::Ipv4Addr;
use std::time::Duration;

/// One entry: an IPv4 address and its MAC address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Neighbor {
    pub ip: Ipv4Addr,
    pub mac: [u8; 6],
}

/// Reads a MAC address written with `:` or `-` between six two-digit hex groups.
fn mac(text: &str) -> Option<[u8; 6]> {
    let parts: Vec<&str> = text.split([':', '-']).collect();
    if parts.len() != 6 {
        return None;
    }
    let mut out = [0u8; 6];
    for (o, p) in out.iter_mut().zip(&parts) {
        if p.is_empty() || p.len() > 2 {
            return None;
        }
        *o = u8::from_str_radix(p, 16).ok()?;
    }
    (out != [0; 6] && out != [0xff; 6]).then_some(out)
}

/// The entries in a neighbour table as Linux writes it (`/proc/net/arp`): address, hardware type,
/// flags, MAC, mask and device; flags 0x0 is an incomplete entry.
pub(crate) fn parse_proc(text: &str) -> Vec<Neighbor> {
    text.lines()
        .skip(1)
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let (ip, flags, hw) = (f.first()?, f.get(2)?, f.get(3)?);
            (*flags != "0x0").then_some(())?;
            Some(Neighbor {
                ip: ip.parse().ok()?,
                mac: mac(hw)?,
            })
        })
        .collect()
}

/// The entries in the output of `arp -a` on Windows (`192.168.1.20   10-9c-70-12-34-56   dynamic`)
/// and `arp -an` on macOS (`? (192.168.1.20) at 10:9c:70:12:34:56 on en0 ifscope [ethernet]`). macOS
/// drops leading zeros (`10:9c:70:1:2:3`), which reads the same.
pub(crate) fn parse_arp(text: &str) -> Vec<Neighbor> {
    text.lines()
        .filter_map(|l| {
            let words: Vec<&str> = l
                .split_whitespace()
                .map(|w| w.trim_matches(|c| c == '(' || c == ')'))
                .collect();
            let ip = words.iter().find_map(|w| w.parse::<Ipv4Addr>().ok())?;
            let mac = words.iter().find_map(|w| mac(w))?;
            Some(Neighbor { ip, mac })
        })
        .collect()
}

/// The neighbour table now, or nothing when it cannot be read within `timeout`.
pub(crate) async fn read(timeout: Duration) -> Vec<Neighbor> {
    let task = tokio::task::spawn_blocking(read_blocking);
    match tokio::time::timeout(timeout, task).await {
        Ok(Ok(n)) => n,
        _ => Vec::new(),
    }
}

fn read_blocking() -> Vec<Neighbor> {
    if cfg!(target_os = "linux") {
        return std::fs::read_to_string("/proc/net/arp")
            .map(|t| parse_proc(&t))
            .unwrap_or_default();
    }
    let mut cmd = std::process::Command::new("arp");
    cmd.arg(if cfg!(windows) { "-a" } else { "-an" });
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: no console flashes up in the desktop app.
        cmd.creation_flags(0x0800_0000);
    }
    cmd.output()
        .map(|o| parse_arp(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

/// The addresses in `table` whose MAC address starts with `prefix`, each once, in table order.
pub(crate) fn with_prefix(table: &[Neighbor], prefix: [u8; 3]) -> Vec<Ipv4Addr> {
    let mut out: Vec<Ipv4Addr> = Vec::new();
    for n in table.iter().filter(|n| n.mac[..3] == prefix) {
        if !out.contains(&n.ip) {
            out.push(n.ip);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_linux_windows_and_macos_tables() {
        let linux = "IP address       HW type     Flags       HW address            Mask     Device\n\
                     192.168.1.20     0x1         0x2         10:9c:70:12:34:56     *        wlan0\n\
                     192.168.1.21     0x1         0x0         00:00:00:00:00:00     *        wlan0\n\
                     192.168.1.1      0x1         0x2         a4:2b:b0:00:11:22     *        wlan0\n";
        let t = parse_proc(linux);
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].ip, Ipv4Addr::new(192, 168, 1, 20));
        let windows = "\nInterface: 192.168.1.10 --- 0x7\n  Internet Address      Physical Address      Type\n  192.168.1.1           a4-2b-b0-00-11-22     dynamic\n  192.168.1.20          10-9c-70-12-34-56     dynamic\n  192.168.1.255         ff-ff-ff-ff-ff-ff     static\n";
        let t = parse_arp(windows);
        assert_eq!(
            with_prefix(&t, [0x10, 0x9c, 0x70]),
            [Ipv4Addr::new(192, 168, 1, 20)]
        );
        assert_eq!(t.len(), 2, "the broadcast entry is left out: {t:?}");
        let macos = "? (192.168.1.20) at 10:9c:70:1:2:3 on en0 ifscope [ethernet]\n? (192.168.1.30) at (incomplete) on en0 ifscope [ethernet]\n";
        let t = parse_arp(macos);
        assert_eq!(
            t,
            [Neighbor {
                ip: Ipv4Addr::new(192, 168, 1, 20),
                mac: [0x10, 0x9c, 0x70, 1, 2, 3]
            }]
        );
    }

    #[test]
    fn lists_each_address_once() {
        let n = Neighbor {
            ip: Ipv4Addr::new(10, 0, 0, 5),
            mac: [0x10, 0x9c, 0x70, 0, 0, 1],
        };
        assert_eq!(with_prefix(&[n, n], [0x10, 0x9c, 0x70]).len(), 1);
        assert!(with_prefix(&[n], [0x10, 0x9c, 0x71]).is_empty());
    }
}
