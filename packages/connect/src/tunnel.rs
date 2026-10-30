// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Remote tunnels to a printer server the drivers already speak (Moonraker, OctoPrint). The only kind
//! today is Obico's cloud tunnel, from Obico's tunnel integration guide
//! (obico.io/docs/user-guides/tunnel-app-integration): the person authorizes an app on Obico's page,
//! which hands back `https://<user>:<password>@<id>.tunnels.app.obico.io`. Requests go to that host
//! with the user and password as HTTP basic auth, and reach the printer server's own API.
//!
//! A tunnel host is on the public internet, so the rules differ from LAN printers:
//! - Only hosts of the form `<one label>.tunnels.app.obico.io` are allowed, over https on 443.
//! - The name must resolve to public addresses only, and the connection uses exactly the addresses
//!   that were checked, so a name that later points into the local network is not followed.
//! - Certificates are checked against the system's trust store; redirects are never followed, so the
//!   credential cannot be carried to another host.
//! - The credential lives in the keychain under the printer's `credential_ref`, goes out only as the
//!   `Authorization` header, and is stripped from anything logged or shown ([`redact_userinfo`]).
//! - Obico counts tunnel data against a monthly cap, so status is read every 15 to 30 seconds
//!   depending on what is left, and `/_tsd_/tunnelusage/` is read before every upload.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use base64::Engine as _;
use reqwest::{Client, Response, header};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result, TunnelProblem};
use crate::types::{PrinterConfig, PrinterStatus, Secrets};

/// Which remote tunnel a printer is reached through (`PrinterConfig::tunnel`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TunnelKind {
    /// Obico's cloud tunnel (`*.tunnels.app.obico.io`). Self-hosted Obico servers are not allowed yet.
    Obico,
}

impl TunnelKind {
    /// The printer plugins whose API the tunnel carries.
    pub fn plugins(self) -> &'static [&'static str] {
        match self {
            TunnelKind::Obico => &["moonraker", "octoprint"],
        }
    }

    /// The domain every tunnel host of this kind sits directly under, with its leading dot.
    fn domain(self) -> &'static str {
        match self {
            TunnelKind::Obico => ".tunnels.app.obico.io",
        }
    }

    const ALL: [TunnelKind; 1] = [TunnelKind::Obico];
}

/// `host`, lowercased, when it is exactly one DNS label directly under `kind`'s tunnel domain: letters,
/// digits and inner hyphens, 1 to 63 of them. No port, user name, trailing dot, IP literal or deeper name.
#[must_use]
pub fn tunnel_host(kind: TunnelKind, host: &str) -> Option<String> {
    let lower = host.to_ascii_lowercase();
    let label = lower.strip_suffix(kind.domain())?;
    label_ok(label).then_some(lower)
}

fn label_ok(label: &str) -> bool {
    (1..=63).contains(&label.len())
        && label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !label.starts_with('-')
        && !label.ends_with('-')
}

/// Whether `host` is a tunnel host of any kind.
#[must_use]
pub fn is_tunnel_host(host: &str) -> bool {
    TunnelKind::ALL.iter().any(|k| tunnel_host(*k, host).is_some())
}

/// Checks a tunnel printer's configuration before it is saved or connected: a tunnel kind, a plugin
/// the tunnel carries, an allowed host, https on 443.
pub fn check_config(cfg: &PrinterConfig) -> Result<()> {
    let Some(kind) = cfg.tunnel else {
        return Err(Error::Config("the printer has no tunnel".to_owned()));
    };
    if !kind.plugins().contains(&cfg.plugin.as_str()) {
        return Err(Error::Config(
            "an Obico tunnel reaches Moonraker and OctoPrint printers only".to_owned(),
        ));
    }
    if tunnel_host(kind, &cfg.host).is_none() {
        return Err(Error::Config(
            "the address is not an Obico tunnel address (<id>.tunnels.app.obico.io)".to_owned(),
        ));
    }
    if cfg.port.is_some_and(|p| p != 443) {
        return Err(Error::Config("an Obico tunnel takes no port".to_owned()));
    }
    if cfg.tls == Some(false) {
        return Err(Error::Config("an Obico tunnel uses https only".to_owned()));
    }
    Ok(())
}

/// A tunnel address as Obico hands it out, split into the host and the credential. `Debug` never
/// shows the credential.
#[derive(Clone, PartialEq, Eq)]
pub struct TunnelEndpoint {
    pub kind: TunnelKind,
    /// The tunnel host, lowercased, without user name, password or port.
    pub host: String,
    credential: Option<String>,
}

impl std::fmt::Debug for TunnelEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TunnelEndpoint")
            .field("kind", &self.kind)
            .field("host", &self.host)
            .field("credential", &self.credential.as_ref().map(|_| "<hidden>"))
            .finish()
    }
}

impl TunnelEndpoint {
    /// Reads `https://<user>:<password>@<id>.tunnels.app.obico.io` (a trailing `/` is fine). Refuses
    /// any other scheme, a port, a path, query or fragment, a user name without a password, and any
    /// host the allow-list refuses. Errors never repeat the address.
    pub fn parse(kind: TunnelKind, url: &str) -> Result<Self> {
        let bad = |why: &str| Error::Config(format!("not an Obico tunnel address: {why}"));
        let (scheme, rest) = url
            .trim()
            .split_once("://")
            .ok_or_else(|| bad("it must start with https://"))?;
        if !scheme.eq_ignore_ascii_case("https") {
            return Err(bad("it must start with https://"));
        }
        let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let (authority, tail) = rest.split_at(end);
        if !(tail.is_empty() || tail == "/") {
            return Err(bad("it has a path, query or fragment"));
        }
        let (userinfo, hostport) = match authority.rsplit_once('@') {
            Some((u, h)) => (Some(u), h),
            None => (None, authority),
        };
        if hostport.contains([':', '[', ']']) {
            return Err(bad("it has a port or an IP address"));
        }
        let host =
            tunnel_host(kind, hostport).ok_or_else(|| bad("the host is not <id>.tunnels.app.obico.io"))?;
        let credential = match userinfo {
            None => None,
            Some(u) => {
                let (user, pass) = u
                    .split_once(':')
                    .ok_or_else(|| bad("the user name has no password"))?;
                let user = percent_decode(user).ok_or_else(|| bad("the user name is malformed"))?;
                let pass = percent_decode(pass).ok_or_else(|| bad("the password is malformed"))?;
                if user.is_empty() || pass.is_empty() || user.contains(':') {
                    return Err(bad("the user name or password is empty"));
                }
                Some(format!("{user}:{pass}"))
            }
        };
        Ok(Self {
            kind,
            host,
            credential,
        })
    }

    /// `user:password` for the keychain, when the address carried one.
    #[must_use]
    pub fn credential(&self) -> Option<&str> {
        self.credential.as_deref()
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while let Some(&b) = bytes.get(i) {
        if b == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b);
            i += 1;
        }
    }
    let text = String::from_utf8(out).ok()?;
    (!text.chars().any(char::is_control)).then_some(text)
}

/// `text` with the user name and password taken out of every `scheme://user:password@host` in it.
/// Everything from the `://` up to the last `@` before the next space or quote goes, so a password
/// with a `/` in it is removed too (the host and path before that `@` with it, which only hides more).
#[must_use]
pub fn redact_userinfo(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '`'))
            .unwrap_or(tail.len());
        let (span, after) = tail.split_at(end);
        match span.rfind('@') {
            Some(at) => out.push_str(span.get(at + 1..).unwrap_or("")),
            None => out.push_str(span),
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

/// Whether an address is on the public internet: not loopback, private, link-local, carrier-grade
/// NAT, unique local, multicast, unspecified, reserved or documentation space.
#[must_use]
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => public_v4(v4),
            None => public_v6(v6),
        },
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    let shared = a == 100 && (64..128).contains(&b);
    let benchmarking = a == 198 && (b == 18 || b == 19);
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || shared
        || benchmarking
        || a == 0
        || a >= 240)
}

fn public_v6(ip: Ipv6Addr) -> bool {
    let [s0, s1, ..] = ip.segments();
    let unique_local = (s0 & 0xfe00) == 0xfc00;
    let link_local = (s0 & 0xffc0) == 0xfe80;
    let documentation = s0 == 0x2001 && s1 == 0x0db8;
    // ::/96 (old IPv4-compatible) and 64:ff9b::/96 translation could reach private IPv4 space.
    let embeds_v4 = s0 == 0 || (s0 == 0x64 && s1 == 0xff9b);
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || unique_local
        || link_local
        || documentation
        || embeds_v4)
}

/// Resolves `host` on 443 and returns its addresses, refusing a name with any address that is not
/// public ([`is_public_ip`]). The caller connects to exactly these addresses.
pub(crate) async fn resolve_public(printer: &str, host: &str) -> Result<Vec<SocketAddr>> {
    let found = tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((host, 443)))
        .await
        .map_err(|_| Error::timeout(printer, "looking up the tunnel address took too long"))?
        .map_err(|e| Error::unreachable(printer, format!("the tunnel address did not resolve: {e}")))?;
    let addrs: Vec<SocketAddr> = found.collect();
    if addrs.is_empty() {
        return Err(Error::unreachable(printer, "the tunnel address did not resolve"));
    }
    if addrs.iter().any(|a| !is_public_ip(a.ip())) {
        return Err(Error::Config(
            "the tunnel address points into a private network, so it is refused".to_owned(),
        ));
    }
    Ok(addrs)
}

/// The tunnel's own refusal in a response from a tunnel host (Obico: 401, 481, 482, 483), if it is one.
/// Responses from any other host are left to the caller.
pub(crate) fn refusal(printer: &str, resp: &Response) -> Option<Error> {
    if !resp.url().host_str().is_some_and(is_tunnel_host) {
        return None;
    }
    problem_for_status(resp.status().as_u16()).map(|p| Error::tunnel(printer, p))
}

/// The tunnel problem an Obico status code stands for.
#[must_use]
pub fn problem_for_status(status: u16) -> Option<TunnelProblem> {
    match status {
        401 => Some(TunnelProblem::AccessRemoved),
        481 => Some(TunnelProblem::DataLimit),
        482 => Some(TunnelProblem::NotConnected),
        483 => Some(TunnelProblem::TimedOut),
        _ => None,
    }
}

/// Obico's `/_tsd_/tunnelusage/` reply: data used this month and the monthly cap, in bytes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TunnelUsage {
    pub total_bytes: f64,
    /// Negative when the cap is unlimited.
    pub monthly_cap_bytes: f64,
    pub reset_in_seconds: Option<u64>,
}

impl TunnelUsage {
    /// Reads `{total, monthly_cap, reset_in_seconds}`. `None` when `total` or `monthly_cap` is missing.
    #[must_use]
    pub fn from_json(v: &serde_json::Value) -> Option<Self> {
        Some(Self {
            total_bytes: v.get("total")?.as_f64()?.max(0.0),
            monthly_cap_bytes: v.get("monthly_cap")?.as_f64()?,
            reset_in_seconds: v.get("reset_in_seconds").and_then(serde_json::Value::as_u64),
        })
    }

    #[must_use]
    pub fn unlimited(&self) -> bool {
        self.monthly_cap_bytes < 0.0
    }

    /// Bytes left this month, or `None` when unlimited.
    #[must_use]
    pub fn left_bytes(&self) -> Option<f64> {
        (!self.unlimited()).then(|| (self.monthly_cap_bytes - self.total_bytes).max(0.0))
    }
}

/// The fastest status reading over a tunnel.
pub const MIN_POLL: Duration = Duration::from_secs(15);
/// The slowest status reading over a tunnel, also used while the usage is unknown.
pub const MAX_POLL: Duration = Duration::from_secs(30);

/// How often to read status over a tunnel: every 15 seconds with no cap or less than half of it used,
/// slowing evenly to every 30 seconds at 90 percent used, and 30 while the usage is unknown.
#[must_use]
pub fn poll_interval(usage: Option<&TunnelUsage>) -> Duration {
    let Some(u) = usage else { return MAX_POLL };
    if u.unlimited() {
        return MIN_POLL;
    }
    if u.monthly_cap_bytes <= 0.0 {
        return MAX_POLL;
    }
    let used = (u.total_bytes / u.monthly_cap_bytes).clamp(0.0, 1.0);
    let t = ((used - 0.5) / 0.4).clamp(0.0, 1.0);
    MIN_POLL + MAX_POLL.saturating_sub(MIN_POLL).mul_f64(t)
}

/// How long a usage reading is trusted before status reading refreshes it.
const USAGE_TTL: Duration = Duration::from_secs(600);

/// An open tunnel for one printer: the client (pinned addresses, platform trust, no redirects, the
/// credential as a default `Authorization` header) and the base URL the driver builds its paths on.
pub(crate) struct Tunnel {
    printer: String,
    client: Client,
    base: String,
    usage: Mutex<Option<(Instant, TunnelUsage)>>,
    /// When status reading last tried to refresh the usage, so a tunnel that does not answer it is
    /// asked once per [`USAGE_TTL`], not on every reading.
    usage_tried: Mutex<Option<Instant>>,
    last_status: tokio::sync::Mutex<Option<(Instant, Result<PrinterStatus>)>>,
}

impl Tunnel {
    /// Checks the configuration, reads the credential from the keychain, resolves the host to public
    /// addresses only and builds the client.
    pub(crate) async fn open(cfg: &PrinterConfig, secrets: &dyn Secrets) -> Result<Self> {
        check_config(cfg)?;
        let kind = cfg
            .tunnel
            .ok_or_else(|| Error::Config("the printer has no tunnel".to_owned()))?;
        let host = tunnel_host(kind, &cfg.host)
            .ok_or_else(|| Error::Config("the address is not an Obico tunnel address".to_owned()))?;
        let credential = cfg
            .credential_ref
            .as_deref()
            .and_then(|r| secrets.get(r))
            .filter(|c| c.contains(':'))
            .ok_or_else(|| Error::tunnel(&cfg.id, TunnelProblem::NoAccess))?;
        #[cfg(test)]
        if let Some(addr) = tests::route(&host) {
            return Self::build(&cfg.id, &host, &[addr], &credential, false);
        }
        let addrs = resolve_public(&cfg.id, &host).await?;
        Self::build(&cfg.id, &host, &addrs, &credential, true)
    }

    /// `https` is false only in this module's tests, which serve plain http on loopback.
    fn build(printer: &str, host: &str, addrs: &[SocketAddr], credential: &str, https: bool) -> Result<Self> {
        let encoded = base64::engine::general_purpose::STANDARD.encode(credential);
        let mut auth = header::HeaderValue::from_str(&format!("Basic {encoded}"))
            .map_err(|_| Error::tunnel(printer, TunnelProblem::NoAccess))?;
        auth.set_sensitive(true);
        let mut headers = header::HeaderMap::new();
        headers.insert(header::AUTHORIZATION, auth);
        let client = Client::builder()
            .use_preconfigured_tls(crate::tls::platform_client_config()?)
            .https_only(https)
            // A redirect could carry the Authorization header to another host.
            .redirect(reqwest::redirect::Policy::none())
            // The addresses were checked; a proxy would resolve the name again.
            .no_proxy()
            .resolve_to_addrs(host, addrs)
            .default_headers(headers)
            .connect_timeout(Duration::from_secs(10))
            // Obico gives up on a printer after 30 seconds (483); this bounds a dead connection.
            .timeout(Duration::from_secs(40))
            .build()
            .map_err(|e| Error::Config(e.without_url().to_string()))?;
        let base = if https {
            format!("https://{host}")
        } else {
            let port = addrs.first().map_or(80, SocketAddr::port);
            format!("http://{host}:{port}")
        };
        Ok(Self {
            printer: printer.to_owned(),
            client,
            base,
            usage: Mutex::new(None),
            usage_tried: Mutex::new(None),
            last_status: tokio::sync::Mutex::new(None),
        })
    }

    pub(crate) fn client(&self) -> Client {
        self.client.clone()
    }

    pub(crate) fn base(&self) -> &str {
        &self.base
    }

    fn cached_usage(&self) -> Option<(Instant, TunnelUsage)> {
        *self.usage.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// How often status is read now, from the last usage reading.
    pub(crate) fn poll_interval(&self) -> Duration {
        poll_interval(self.cached_usage().map(|(_, u)| u).as_ref())
    }

    /// Reads `/_tsd_/tunnelusage/` and keeps it.
    pub(crate) async fn read_usage(&self) -> Result<TunnelUsage> {
        let url = format!("{}/_tsd_/tunnelusage/", self.base);
        let resp = crate::http::send(&self.printer, self.client.get(url)).await?;
        let v = crate::http::json(&self.printer, resp).await?;
        let usage = TunnelUsage::from_json(&v)
            .ok_or_else(|| Error::protocol(&self.printer, "the tunnel usage reply has no total or cap"))?;
        *self.usage.lock().unwrap_or_else(PoisonError::into_inner) = Some((Instant::now(), usage));
        Ok(usage)
    }

    /// Reads the usage before an upload of `bytes` and refuses one that would not fit in what is left
    /// this month. A tunnel refusal stops the upload; any other failure to read the usage does not,
    /// since the tunnel enforces its cap itself (481).
    pub(crate) async fn check_upload(&self, bytes: usize) -> Result<()> {
        match self.read_usage().await {
            Ok(u) => match u.left_bytes() {
                Some(left) if left <= 0.0 => Err(Error::tunnel(&self.printer, TunnelProblem::DataLimit)),
                #[allow(clippy::cast_precision_loss)]
                Some(left) if bytes as f64 > left => {
                    Err(Error::tunnel(&self.printer, TunnelProblem::FileOverDataLimit))
                }
                _ => Ok(()),
            },
            Err(e @ Error::Tunnel { .. }) => Err(e),
            Err(e) => {
                crate::trace(
                    &self.printer,
                    format_args!("tunnel usage not read before upload: {e}"),
                );
                Ok(())
            }
        }
    }

    /// Status at most once per [`Self::poll_interval`], whoever asks (the event stream, the hub's
    /// watcher, a client): within the interval the last answer is returned again. The usage reading is
    /// refreshed along the way when it is older than ten minutes.
    pub(crate) async fn status<F, Fut>(&self, fetch: F) -> Result<PrinterStatus>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<PrinterStatus>>,
    {
        let mut last = self.last_status.lock().await;
        if let Some((at, result)) = last.as_ref()
            && at.elapsed() < self.poll_interval()
        {
            return result.clone();
        }
        let due = {
            let mut tried = self.usage_tried.lock().unwrap_or_else(PoisonError::into_inner);
            let due = tried.is_none_or(|at| at.elapsed() >= USAGE_TTL);
            if due {
                *tried = Some(Instant::now());
            }
            due
        };
        if due && let Err(e) = self.read_usage().await {
            crate::trace(&self.printer, format_args!("tunnel usage not read: {e}"));
        }
        let result = fetch().await;
        *last = Some((Instant::now(), result.clone()));
        result
    }

    /// The event stream's wait between readings: the tunnel's when there is one, else `fallback`.
    pub(crate) fn every(tunnel: Option<&std::sync::Arc<Tunnel>>, fallback: Duration) -> crate::poll::Every {
        match tunnel {
            Some(t) => {
                let t = t.clone();
                std::sync::Arc::new(move || t.poll_interval())
            }
            None => std::sync::Arc::new(move || fallback),
        }
    }

    /// Drops the kept status, so the next reading after a print action goes to the printer.
    pub(crate) async fn forget_status(&self) {
        *self.last_status.lock().await = None;
    }
}

#[cfg(test)]
mod tests;
