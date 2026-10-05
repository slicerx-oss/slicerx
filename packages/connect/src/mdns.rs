// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Multicast DNS (RFC 6762) and DNS-SD (RFC 6763), just enough to find printers and to advertise
//! one service. Browsing sends a query from an ephemeral port, so responders answer to that port
//! by unicast (RFC 6762 section 6.7) and nothing here binds 5353. The wire code is pure and
//! tested without a network; [`browse`] and [`Advert`] are the two users.
use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use tokio::net::UdpSocket;

use crate::types::DiscoveredPrinter;

pub const MDNS_PORT: u16 = 5353;
pub const MDNS_GROUP_V4: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
/// The DNS-SD name a browser asks to list every service type on the link.
pub const META_QUERY: &str = "_services._dns-sd._udp.local";

const TYPE_A: u16 = 1;
const TYPE_PTR: u16 = 12;
const TYPE_TXT: u16 = 16;
const TYPE_AAAA: u16 = 28;
const TYPE_SRV: u16 = 33;
const CLASS_IN: u16 = 1;
const CACHE_FLUSH: u16 = 0x8000;
const MAX_NAME: usize = 255;
const MAX_LABEL: usize = 63;

/// Service types browsed for printers, and the plugin each one maps to. The Moonraker and
/// OctoPrint names are announced by those projects. The Prusa and Duet names are what their
/// firmware documentation suggests and have not been seen on hardware.
pub const PRINTER_SERVICES: [(&str, &str); 5] = [
    ("_moonraker._tcp.local", "moonraker"),
    ("_octoprint._tcp.local", "octoprint"),
    ("_prusalink._tcp.local", "prusalink"),
    ("_prusa-link._tcp.local", "prusalink"),
    ("_duet._tcp.local", "duet"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rdata {
    Ptr(String),
    Srv { port: u16, target: String },
    Txt(Vec<String>),
    A(Ipv4Addr),
    Aaaa(Ipv6Addr),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub name: String,
    pub ttl: u32,
    pub data: Rdata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub name: String,
    pub qtype: u16,
    /// The QU bit: the asker prefers a unicast answer.
    pub unicast: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Message {
    pub response: bool,
    pub questions: Vec<Question>,
    /// Answers, authority and additional records together; mDNS does not distinguish them.
    pub records: Vec<Record>,
}

fn put_name(out: &mut Vec<u8>, name: &str) -> Option<()> {
    let name = name.trim_end_matches('.');
    if name.len() > MAX_NAME {
        return None;
    }
    if !name.is_empty() {
        for label in name.split('.') {
            let len = u8::try_from(label.len())
                .ok()
                .filter(|l| usize::from(*l) <= MAX_LABEL)?;
            if len == 0 {
                return None;
            }
            out.push(len);
            out.extend_from_slice(label.as_bytes());
        }
    }
    out.push(0);
    Some(())
}

fn header(out: &mut Vec<u8>, flags: u16, questions: usize, answers: usize) -> Option<()> {
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&flags.to_be_bytes());
    out.extend_from_slice(&u16::try_from(questions).ok()?.to_be_bytes());
    out.extend_from_slice(&u16::try_from(answers).ok()?.to_be_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    Some(())
}

/// A query for the PTR records of each name. Empty when a name cannot be encoded.
pub fn encode_query(names: &[&str]) -> Vec<u8> {
    let mut out = Vec::new();
    let build = |out: &mut Vec<u8>| -> Option<()> {
        header(out, 0, names.len(), 0)?;
        for n in names {
            put_name(out, n)?;
            out.extend_from_slice(&TYPE_PTR.to_be_bytes());
            out.extend_from_slice(&CLASS_IN.to_be_bytes());
        }
        Some(())
    };
    if build(&mut out).is_none() {
        out.clear();
    }
    out
}

/// A response carrying `records`. Empty when a record cannot be encoded.
pub fn encode_response(records: &[Record]) -> Vec<u8> {
    let mut out = Vec::new();
    let build = |out: &mut Vec<u8>| -> Option<()> {
        header(out, 0x8400, 0, records.len())?;
        for r in records {
            put_name(out, &r.name)?;
            let (ty, body) = encode_rdata(&r.data)?;
            out.extend_from_slice(&ty.to_be_bytes());
            // Shared records (PTR) must not carry the cache-flush bit; unique ones do.
            let class = if matches!(r.data, Rdata::Ptr(_)) {
                CLASS_IN
            } else {
                CLASS_IN | CACHE_FLUSH
            };
            out.extend_from_slice(&class.to_be_bytes());
            out.extend_from_slice(&r.ttl.to_be_bytes());
            out.extend_from_slice(&u16::try_from(body.len()).ok()?.to_be_bytes());
            out.extend_from_slice(&body);
        }
        Some(())
    };
    if build(&mut out).is_none() {
        out.clear();
    }
    out
}

fn encode_rdata(d: &Rdata) -> Option<(u16, Vec<u8>)> {
    let mut b = Vec::new();
    let ty = match d {
        Rdata::Ptr(n) => {
            put_name(&mut b, n)?;
            TYPE_PTR
        }
        Rdata::Srv { port, target } => {
            b.extend_from_slice(&[0, 0, 0, 0]);
            b.extend_from_slice(&port.to_be_bytes());
            put_name(&mut b, target)?;
            TYPE_SRV
        }
        Rdata::Txt(items) => {
            if items.is_empty() {
                b.push(0);
            }
            for i in items {
                b.push(u8::try_from(i.len()).ok()?);
                b.extend_from_slice(i.as_bytes());
            }
            TYPE_TXT
        }
        Rdata::A(ip) => {
            b.extend_from_slice(&ip.octets());
            TYPE_A
        }
        Rdata::Aaaa(ip) => {
            b.extend_from_slice(&ip.octets());
            TYPE_AAAA
        }
    };
    Some((ty, b))
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn u8(&mut self) -> Option<u8> {
        let v = *self.buf.get(self.pos)?;
        self.pos += 1;
        Some(v)
    }

    fn u16(&mut self) -> Option<u16> {
        Some(u16::from_be_bytes([self.u8()?, self.u8()?]))
    }

    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_be_bytes([
            self.u8()?,
            self.u8()?,
            self.u8()?,
            self.u8()?,
        ]))
    }

    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let s = self.buf.get(self.pos..self.pos.checked_add(n)?)?;
        self.pos += n;
        Some(s)
    }

    /// A possibly compressed name starting at the cursor. Pointers may only go backwards, which
    /// rules out loops, and a name is capped at 255 bytes.
    fn name(&mut self) -> Option<String> {
        let (name, next) = name_at(self.buf, self.pos)?;
        self.pos = next;
        Some(name)
    }
}

/// Reads the name at `start`. Returns the name and the offset just after it in the record.
fn name_at(buf: &[u8], start: usize) -> Option<(String, usize)> {
    let mut out = String::new();
    let mut pos = start;
    let mut after = None;
    let mut low = start;
    loop {
        let len = usize::from(*buf.get(pos)?);
        if len == 0 {
            pos += 1;
            break;
        }
        if len & 0xC0 == 0xC0 {
            let ptr = ((len & 0x3F) << 8) | usize::from(*buf.get(pos + 1)?);
            after.get_or_insert(pos + 2);
            if ptr >= low {
                return None;
            }
            low = ptr;
            pos = ptr;
            continue;
        }
        if len > MAX_LABEL {
            return None;
        }
        let label = buf.get(pos + 1..pos + 1 + len)?;
        if !out.is_empty() {
            out.push('.');
        }
        out.push_str(std::str::from_utf8(label).ok()?);
        if out.len() > MAX_NAME {
            return None;
        }
        pos += 1 + len;
    }
    Some((out, after.unwrap_or(pos)))
}

/// Parses a packet. `None` for anything malformed or truncated.
pub fn parse(buf: &[u8]) -> Option<Message> {
    let mut r = Reader { buf, pos: 0 };
    r.take(2)?;
    let flags = r.u16()?;
    let (qd, an, ns, ar) = (r.u16()?, r.u16()?, r.u16()?, r.u16()?);
    let mut msg = Message {
        response: flags & 0x8000 != 0,
        ..Message::default()
    };
    for _ in 0..qd {
        let name = r.name()?;
        let qtype = r.u16()?;
        let class = r.u16()?;
        msg.questions.push(Question {
            name,
            qtype,
            unicast: class & 0x8000 != 0,
        });
    }
    let total = usize::from(an) + usize::from(ns) + usize::from(ar);
    for _ in 0..total {
        let name = r.name()?;
        let ty = r.u16()?;
        r.u16()?;
        let ttl = r.u32()?;
        let len = usize::from(r.u16()?);
        let start = r.pos;
        let body = r.take(len)?;
        let data = match ty {
            TYPE_PTR => Some(Rdata::Ptr(name_at(buf, start)?.0)),
            TYPE_SRV => {
                let port = u16::from_be_bytes([*body.get(4)?, *body.get(5)?]);
                Some(Rdata::Srv {
                    port,
                    target: name_at(buf, start + 6)?.0,
                })
            }
            TYPE_TXT => {
                let mut items = Vec::new();
                let mut i = 0;
                while i < body.len() {
                    let l = usize::from(*body.get(i)?);
                    let s = body.get(i + 1..i + 1 + l)?;
                    if l > 0 {
                        items.push(String::from_utf8_lossy(s).into_owned());
                    }
                    i += 1 + l;
                }
                Some(Rdata::Txt(items))
            }
            TYPE_A => <[u8; 4]>::try_from(body)
                .ok()
                .map(|o| Rdata::A(Ipv4Addr::from(o))),
            TYPE_AAAA => <[u8; 16]>::try_from(body)
                .ok()
                .map(|o| Rdata::Aaaa(Ipv6Addr::from(o))),
            _ => None,
        };
        if let Some(data) = data {
            msg.records.push(Record { name, ttl, data });
        }
    }
    Some(msg)
}

/// One service instance found on the network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Service {
    /// `_moonraker._tcp.local`
    pub service: String,
    /// The instance label, such as `voron`.
    pub instance: String,
    pub host_name: String,
    pub port: u16,
    pub addresses: Vec<IpAddr>,
    pub txt: Vec<String>,
}

/// Groups the records of several packets into services. `sources` are the addresses the packets
/// came from, used when a responder leaves out the address records.
pub fn assemble(packets: &[(IpAddr, Message)]) -> Vec<Service> {
    let mut ptrs: BTreeMap<String, String> = BTreeMap::new();
    let mut srv: BTreeMap<String, (String, u16, IpAddr)> = BTreeMap::new();
    let mut txt: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut addrs: BTreeMap<String, Vec<IpAddr>> = BTreeMap::new();
    for (src, m) in packets {
        if !m.response {
            continue;
        }
        for r in &m.records {
            let key = r.name.to_ascii_lowercase();
            match &r.data {
                // A goodbye (ttl 0) removes nothing we saw and adds nothing.
                _ if r.ttl == 0 => {}
                Rdata::Ptr(inst) => {
                    ptrs.insert(inst.clone(), r.name.clone());
                }
                Rdata::Srv { port, target } => {
                    srv.insert(r.name.clone(), (target.clone(), *port, *src));
                }
                Rdata::Txt(t) => {
                    txt.insert(r.name.clone(), t.clone());
                }
                Rdata::A(ip) => addrs.entry(key).or_default().push(IpAddr::V4(*ip)),
                Rdata::Aaaa(ip) => addrs.entry(key).or_default().push(IpAddr::V6(*ip)),
            }
        }
    }
    let mut out = Vec::new();
    for (inst, service) in ptrs {
        let Some((target, port, src)) = srv.get(&inst) else {
            continue;
        };
        let mut list = addrs
            .get(&target.to_ascii_lowercase())
            .cloned()
            .unwrap_or_default();
        if list.is_empty() {
            list.push(*src);
        }
        list.sort();
        list.dedup();
        let suffix = format!(".{service}");
        let label = inst.strip_suffix(&suffix).unwrap_or(&inst);
        out.push(Service {
            service: service.clone(),
            instance: label.to_owned(),
            host_name: target.clone(),
            port: *port,
            addresses: list,
            txt: txt.get(&inst).cloned().unwrap_or_default(),
        });
    }
    out
}

/// Asks the network for `services` and collects answers for `window`. `target` is where the query
/// goes: [`MDNS_GROUP_V4`] on port 5353 in production, a local socket in tests. The query is sent
/// again after a third and two thirds of the window because multicast is lossy.
pub async fn browse(services: &[&str], target: SocketAddr, window: Duration) -> Vec<Service> {
    let query = encode_query(services);
    if query.is_empty() {
        return Vec::new();
    }
    // A loopback target (tests) gets a loopback socket, so the OS firewall has nothing to ask. A
    // multicast query goes out of every local network, from a socket per interface: one socket on
    // 0.0.0.0 reaches only the network the OS picks, a virtual adapter on many Windows machines.
    let mut socks = Vec::new();
    match target.ip() {
        ip if ip.is_loopback() => socks.extend(UdpSocket::bind((ip, 0)).await.ok()),
        IpAddr::V4(_) => {
            for i in crate::netif::lan_v4() {
                socks.extend(crate::netif::sender(i.ip).ok());
            }
            if socks.is_empty() {
                socks.extend(UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await.ok());
            }
        }
        IpAddr::V6(_) => socks.extend(UdpSocket::bind((Ipv6Addr::UNSPECIFIED, 0)).await.ok()),
    }
    let runs = socks.into_iter().map(|sock| ask(sock, &query, target, window));
    let packets: Vec<(IpAddr, Message)> = futures::future::join_all(runs)
        .await
        .into_iter()
        .flatten()
        .collect();
    assemble(&packets)
}

/// Sends `query` at the start and after a third and two thirds of the window, and keeps every
/// answer that parses.
async fn ask(sock: UdpSocket, query: &[u8], target: SocketAddr, window: Duration) -> Vec<(IpAddr, Message)> {
    let end = tokio::time::Instant::now() + window;
    let step = window / 3;
    let mut next_send = tokio::time::Instant::now();
    let mut packets = Vec::new();
    let mut buf = vec![0_u8; 9000];
    loop {
        let now = tokio::time::Instant::now();
        if now >= end {
            break;
        }
        if now >= next_send {
            let _ = sock.send_to(query, target).await;
            next_send = now + step.max(Duration::from_millis(50));
        }
        let wake = next_send.min(end);
        if let Ok(Ok((n, from))) = tokio::time::timeout_at(wake, sock.recv_from(&mut buf)).await
            && let Some(m) = buf.get(..n).and_then(parse)
        {
            packets.push((from.ip(), m));
        }
    }
    packets
}

/// Printers announced by [`PRINTER_SERVICES`]. Hosts that are not on the local network are the
/// caller's to drop.
pub async fn browse_printers(target: SocketAddr, window: Duration) -> Vec<DiscoveredPrinter> {
    let types: Vec<&str> = PRINTER_SERVICES.iter().map(|(t, _)| *t).collect();
    let mut out: Vec<DiscoveredPrinter> = Vec::new();
    for s in browse(&types, target, window).await {
        let Some((_, plugin)) = PRINTER_SERVICES
            .iter()
            .find(|(t, _)| t.eq_ignore_ascii_case(&s.service))
        else {
            continue;
        };
        // IPv4 first: printers are reached by address, and link-local IPv6 needs a zone.
        let Some(addr) = s
            .addresses
            .iter()
            .find(|a| a.is_ipv4())
            .or_else(|| s.addresses.first())
        else {
            continue;
        };
        let p = DiscoveredPrinter {
            plugin: (*plugin).to_owned(),
            host: addr.to_string(),
            port: Some(s.port),
            name: Some(s.instance.clone()),
            model: None,
            serial: None,
            firmware: None,
            lan_only: None,
        };
        if !out
            .iter()
            .any(|o| o.plugin == p.plugin && o.host == p.host && o.port == p.port)
        {
            out.push(p);
        }
    }
    out
}

/// One service this machine offers: the records to announce and the logic that answers queries.
#[derive(Debug, Clone)]
pub struct Advert {
    /// `_slicerx._tcp.local`
    pub service: String,
    /// The instance label. Pick one that says nothing about the user or the machine.
    pub instance: String,
    /// `sx-1a2b3c4d.local`
    pub host: String,
    pub port: u16,
    pub addresses: Vec<IpAddr>,
    pub txt: Vec<String>,
}

impl Advert {
    fn instance_name(&self) -> String {
        format!("{}.{}", self.instance, self.service)
    }

    /// PTR, SRV, TXT and address records, with `ttl` seconds (0 withdraws them).
    pub fn records(&self, ttl: u32) -> Vec<Record> {
        let inst = self.instance_name();
        let mut v = vec![
            Record {
                name: self.service.clone(),
                ttl,
                data: Rdata::Ptr(inst.clone()),
            },
            Record {
                name: inst.clone(),
                ttl,
                data: Rdata::Srv {
                    port: self.port,
                    target: self.host.clone(),
                },
            },
            Record {
                name: inst,
                ttl,
                data: Rdata::Txt(self.txt.clone()),
            },
        ];
        for a in &self.addresses {
            v.push(Record {
                name: self.host.clone(),
                ttl,
                data: match a {
                    IpAddr::V4(a) => Rdata::A(*a),
                    IpAddr::V6(a) => Rdata::Aaaa(*a),
                },
            });
        }
        v
    }

    /// The unsolicited announcement sent when the service starts.
    pub fn announcement(&self) -> Vec<u8> {
        encode_response(&self.records(120))
    }

    /// Withdraws the service when it stops.
    pub fn goodbye(&self) -> Vec<u8> {
        encode_response(&self.records(0))
    }

    /// The response to a query packet, or `None` when it asks about nothing we own. A query that
    /// prefers unicast (or came from a port other than 5353) is answered to the sender alone; the
    /// caller decides that from the returned flag.
    pub fn answer(&self, packet: &[u8]) -> Option<(Vec<u8>, bool)> {
        let m = parse(packet)?;
        if m.response {
            return None;
        }
        let inst = self.instance_name();
        let hit = m.questions.iter().any(|q| {
            let n = q.name.as_str();
            n.eq_ignore_ascii_case(&self.service)
                || n.eq_ignore_ascii_case(&inst)
                || n.eq_ignore_ascii_case(&self.host)
                || n.eq_ignore_ascii_case(META_QUERY)
        });
        if !hit {
            return None;
        }
        let mut records = self.records(120);
        if m.questions
            .iter()
            .any(|q| q.name.eq_ignore_ascii_case(META_QUERY))
        {
            records.push(Record {
                name: META_QUERY.to_owned(),
                ttl: 120,
                data: Rdata::Ptr(self.service.clone()),
            });
        }
        let unicast = m.questions.iter().all(|q| q.unicast);
        Some((encode_response(&records), unicast))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn advert() -> Advert {
        Advert {
            service: "_slicerx._tcp.local".to_owned(),
            instance: "SlicerX-1a2b".to_owned(),
            host: "sx-1a2b3c4d.local".to_owned(),
            port: 47616,
            addresses: vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20))],
            txt: vec!["v=1".to_owned()],
        }
    }

    #[test]
    fn a_response_round_trips_through_the_parser() {
        let a = advert();
        let m = parse(&a.announcement()).unwrap();
        assert!(m.response);
        assert_eq!(m.records.len(), 4);
        let svc = assemble(&[(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)), m)]);
        assert_eq!(svc.len(), 1);
        assert_eq!(svc[0].instance, "SlicerX-1a2b");
        assert_eq!(svc[0].port, 47616);
        assert_eq!(svc[0].addresses, vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20))]);
        assert_eq!(svc[0].txt, vec!["v=1".to_owned()]);
    }

    #[test]
    fn a_goodbye_announces_nothing() {
        let m = parse(&advert().goodbye()).unwrap();
        assert!(assemble(&[(IpAddr::V4(Ipv4Addr::LOCALHOST), m)]).is_empty());
    }

    #[test]
    fn queries_are_answered_only_for_our_names() {
        let a = advert();
        assert!(a.answer(&encode_query(&["_slicerx._tcp.local"])).is_some());
        assert!(
            a.answer(&encode_query(&["SLICERX-1A2B._slicerx._tcp.local"]))
                .is_some()
        );
        assert!(a.answer(&encode_query(&["_ipp._tcp.local"])).is_none());
        // Never answer a response, or two responders would echo each other forever.
        assert!(a.answer(&a.announcement()).is_none());
        let (meta, _) = a.answer(&encode_query(&[META_QUERY])).unwrap();
        assert!(parse(&meta).unwrap().records.iter().any(|r| r.name == META_QUERY));
    }

    #[test]
    fn compressed_names_are_followed_and_loops_are_refused() {
        // Header for one answer, then a name that points back at itself.
        let mut p = vec![0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0];
        p.extend_from_slice(&[0xC0, 12]);
        p.extend_from_slice(&[0, 1, 0, 1, 0, 0, 0, 10, 0, 4, 1, 2, 3, 4]);
        assert!(parse(&p).is_none());
        // A name whose second half is compressed.
        let mut q = vec![0, 0, 0x84, 0, 0, 0, 0, 2, 0, 0, 0, 0];
        put_name(&mut q, "a.local").unwrap();
        q.extend_from_slice(&[0, 1, 0, 1, 0, 0, 0, 10, 0, 4, 1, 2, 3, 4]);
        q.extend_from_slice(&[1, b'b', 0xC0, 14]);
        q.extend_from_slice(&[0, 1, 0, 1, 0, 0, 0, 10, 0, 4, 5, 6, 7, 8]);
        let m = parse(&q).unwrap();
        assert_eq!(m.records.get(1).unwrap().name, "b.local");
    }

    #[test]
    fn truncated_and_garbage_packets_are_refused() {
        let full = advert().announcement();
        for n in 0..full.len() {
            assert!(parse(&full[..n]).is_none() || n == full.len(), "{n}");
        }
        assert!(parse(&[0xff; 64]).is_none());
        assert!(encode_query(&["a..b"]).is_empty());
    }

    #[tokio::test]
    async fn browse_finds_a_responder_over_udp() {
        // A printer stand-in: answers any `_moonraker._tcp` query by unicast to the sender.
        let responder = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let target = responder.local_addr().unwrap();
        let printer = Advert {
            service: "_moonraker._tcp.local".to_owned(),
            instance: "voron".to_owned(),
            host: "voron.local".to_owned(),
            port: 7125,
            addresses: vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50))],
            txt: Vec::new(),
        };
        let task = tokio::spawn(async move {
            let mut buf = vec![0_u8; 2048];
            loop {
                let Ok((n, from)) = responder.recv_from(&mut buf).await else {
                    return;
                };
                if let Some((resp, _)) = printer.answer(&buf[..n]) {
                    let _ = responder.send_to(&resp, from).await;
                }
            }
        });
        let found = browse_printers(target, Duration::from_millis(400)).await;
        task.abort();
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].plugin, "moonraker");
        assert_eq!(found[0].host, "192.168.1.50");
        assert_eq!(found[0].port, Some(7125));
        assert_eq!(found[0].name.as_deref(), Some("voron"));
    }
}
