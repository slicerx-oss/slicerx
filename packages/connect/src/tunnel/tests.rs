// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Tunnel tests. Everything runs against plain http mock servers on 127.0.0.1: a test routes a tunnel
//! host to its mock with [`route`], which exists only in test builds. Nothing here reaches Obico.
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;
use crate::error::ErrorCode;
use crate::types::PrinterState;
use crate::{MemoryGate, MemorySecrets, PrinterConnector, SecretStore};

static ROUTES: Mutex<BTreeMap<String, SocketAddr>> = Mutex::new(BTreeMap::new());

/// The mock a test routed `host` to.
pub(super) fn route(host: &str) -> Option<SocketAddr> {
    ROUTES.lock().unwrap().get(host).copied()
}

fn add_route(host: &str, addr: SocketAddr) {
    ROUTES.lock().unwrap().insert(host.to_owned(), addr);
}

const DOMAIN: &str = ".tunnels.app.obico.io";

// ---------------------------------------------------------------- allow-list

#[test]
fn only_one_label_directly_under_the_obico_tunnel_domain_is_allowed() {
    for ok in [
        "abc123.tunnels.app.obico.io",
        "a.tunnels.app.obico.io",
        "a-b-9.tunnels.app.obico.io",
        "ABC123.Tunnels.App.Obico.IO",
    ] {
        assert_eq!(
            tunnel_host(TunnelKind::Obico, ok).as_deref(),
            Some(ok.to_ascii_lowercase().as_str()),
            "{ok}"
        );
    }
    let long = format!("{}{DOMAIN}", "a".repeat(64));
    for bad in [
        "",
        "tunnels.app.obico.io",
        ".tunnels.app.obico.io",
        "a.b.tunnels.app.obico.io",
        "abc.tunnels.app.obico.io.",
        "abc.tunnels.app.obico.io.evil.example",
        "abc.tunnels.app.obico.io-evil.example",
        "abc-tunnels.app.obico.io",
        "abctunnels.app.obico.io",
        "abc.tunnels-app.obico.io",
        "abc.app.obico.io",
        "abc.tunnels.app.obico.com",
        "abc.tunnels.app.obico.ioo",
        "abc.tunnels.app.0bico.io",
        "abc.tunnels.app.obico.io:443",
        "abc.tunnels.app.obico.io:8443",
        "user:pass@abc.tunnels.app.obico.io",
        "abc.tunnels.app.obico.io@evil.example",
        "abc.tunnels.app.obico.io/x",
        "abc%2etunnels.app.obico.io",
        "-abc.tunnels.app.obico.io",
        "abc-.tunnels.app.obico.io",
        "ab_c.tunnels.app.obico.io",
        "ab c.tunnels.app.obico.io",
        "\u{430}bc.tunnels.app.obico.io",
        "abc.tunnels.app.obico.io\u{2024}",
        long.as_str(),
        "127.0.0.1",
        "8.8.8.8",
        "::1",
        "[::1]",
        "192.168.1.20",
        "printer.local",
        "app.obico.io",
    ] {
        assert!(tunnel_host(TunnelKind::Obico, bad).is_none(), "{bad:?}");
        assert!(!is_tunnel_host(bad), "{bad:?}");
    }
}

#[test]
fn a_tunnel_address_is_https_with_a_user_and_password_and_nothing_else() {
    let ep = TunnelEndpoint::parse(
        TunnelKind::Obico,
        "https://u1:s3cretpw@Abc123.tunnels.app.obico.io",
    )
    .unwrap();
    assert_eq!(ep.host, "abc123.tunnels.app.obico.io");
    assert_eq!(ep.credential(), Some("u1:s3cretpw"));
    let ep = TunnelEndpoint::parse(
        TunnelKind::Obico,
        " HTTPS://u1:p%40ss%2Fw@abc.tunnels.app.obico.io/ ",
    )
    .unwrap();
    assert_eq!(ep.credential(), Some("u1:p@ss/w"));
    let ep = TunnelEndpoint::parse(TunnelKind::Obico, "https://abc.tunnels.app.obico.io").unwrap();
    assert_eq!(ep.credential(), None);

    for bad in [
        "http://u1:s3cretpw@abc.tunnels.app.obico.io",
        "wss://u1:s3cretpw@abc.tunnels.app.obico.io",
        "ftp://u1:s3cretpw@abc.tunnels.app.obico.io",
        "abc.tunnels.app.obico.io",
        "//u1:s3cretpw@abc.tunnels.app.obico.io",
        "https://u1:s3cretpw@abc.tunnels.app.obico.io:443",
        "https://u1:s3cretpw@abc.tunnels.app.obico.io:8443/",
        "https://u1:s3cretpw@abc.tunnels.app.obico.io/api",
        "https://u1:s3cretpw@abc.tunnels.app.obico.io?x=1",
        "https://u1:s3cretpw@abc.tunnels.app.obico.io#f",
        "https://abc.tunnels.app.obico.io@evil.example",
        "https://u1:s3cretpw@evil.example/?abc.tunnels.app.obico.io",
        "https://u1:s3cretpw@evil.example#@abc.tunnels.app.obico.io",
        "https://u1:s3cretpw@abc.tunnels.app.obico.io.evil.example",
        "https://u1@abc.tunnels.app.obico.io",
        "https://:s3cretpw@abc.tunnels.app.obico.io",
        "https://u1:@abc.tunnels.app.obico.io",
        "https://u1:s3cret%zzpw@abc.tunnels.app.obico.io",
        "https://u1:s3cret%0apw@abc.tunnels.app.obico.io",
        "https://u1:s3cretpw@127.0.0.1",
        "https://u1:s3cretpw@8.8.8.8",
        "https://u1:s3cretpw@[::1]",
        "https://u1:s3cretpw@a.b.tunnels.app.obico.io",
    ] {
        let err = TunnelEndpoint::parse(TunnelKind::Obico, bad)
            .unwrap_err()
            .to_string();
        assert!(!err.contains("s3cret"), "{bad}: {err}");
        assert!(!err.contains("evil"), "{bad}: {err}");
    }
}

#[test]
fn a_tunnel_endpoint_never_shows_its_credential() {
    let ep =
        TunnelEndpoint::parse(TunnelKind::Obico, "https://u1:s3cretpw@abc.tunnels.app.obico.io").unwrap();
    let shown = format!("{ep:?}");
    assert!(!shown.contains("s3cretpw") && !shown.contains("u1:"), "{shown}");
    assert!(shown.contains("abc.tunnels.app.obico.io"), "{shown}");
}

fn tunnel_cfg(id: &str, plugin: &str, host: &str) -> PrinterConfig {
    PrinterConfig {
        id: id.to_owned(),
        name: id.to_owned(),
        plugin: plugin.to_owned(),
        host: host.to_owned(),
        port: None,
        credential_ref: Some(format!("{id}-tunnel")),
        serial: None,
        tls: None,
        poll_ms: Some(50),
        ftp_port: None,
        camera_port: None,
        ws_port: None,
        http_port: None,
        protocol: None,
        username: None,
        camera_url: None,
        camera_credential_ref: None,
        rtsp_port: None,
        tunnel: Some(TunnelKind::Obico),
    }
}

#[test]
fn a_tunnel_printer_config_is_checked_before_anything_is_sent() {
    let good = tunnel_cfg("p", "octoprint", "abc.tunnels.app.obico.io");
    check_config(&good).unwrap();
    check_config(&tunnel_cfg("p", "moonraker", "abc.tunnels.app.obico.io")).unwrap();
    let with = |f: &dyn Fn(&mut PrinterConfig)| {
        let mut c = good.clone();
        f(&mut c);
        check_config(&c).unwrap_err()
    };
    with(&|c| c.tunnel = None);
    with(&|c| c.plugin = "bambu".to_owned());
    with(&|c| c.plugin = "creality".to_owned());
    with(&|c| c.port = Some(8443));
    with(&|c| c.port = Some(80));
    with(&|c| c.tls = Some(false));
    with(&|c| c.host = "192.168.1.20".to_owned());
    with(&|c| c.host = "abc.tunnels.app.obico.io.evil.example".to_owned());
    with(&|c| c.host = "u:p@abc.tunnels.app.obico.io".to_owned());
    let mut ok443 = good.clone();
    ok443.port = Some(443);
    check_config(&ok443).unwrap();
}

#[test]
fn a_tunnel_printer_never_gets_a_direct_lan_client() {
    let cfg = tunnel_cfg("p", "octoprint", "abc.tunnels.app.obico.io");
    assert!(crate::http::client(&cfg).is_err());
}

// ---------------------------------------------------------------- resolving

#[test]
fn only_public_addresses_pass() {
    for bad in [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.10.10",
        "100.64.0.1",
        "100.127.255.254",
        "0.0.0.0",
        "0.1.2.3",
        "255.255.255.255",
        "224.0.0.251",
        "240.0.0.1",
        "192.0.2.1",
        "198.18.0.1",
        "::",
        "::1",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        "ff02::fb",
        "2001:db8::1",
        "::ffff:127.0.0.1",
        "::ffff:192.168.1.1",
        "::127.0.0.1",
        "64:ff9b::a00:1",
    ] {
        let ip: IpAddr = bad.parse().unwrap();
        assert!(!is_public_ip(ip), "{bad}");
    }
    for ok in [
        "8.8.8.8",
        "1.1.1.1",
        "100.128.0.1",
        "172.32.0.1",
        "2606:4700::1111",
        "::ffff:8.8.8.8",
    ] {
        let ip: IpAddr = ok.parse().unwrap();
        assert!(is_public_ip(ip), "{ok}");
    }
}

#[tokio::test]
async fn a_name_that_resolves_to_this_machine_is_refused() {
    // `localhost` resolves from the hosts file, with no network.
    let e = resolve_public("p", "localhost").await.unwrap_err();
    assert!(e.to_string().contains("private network"), "{e}");
}

// ---------------------------------------------------------------- mock server

#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

type Reply = (u16, Vec<(&'static str, String)>, String);

struct Mock {
    addr: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
    conns: Arc<AtomicUsize>,
}

impl Mock {
    async fn start(answer: impl Fn(&Seen) -> Reply + Send + Sync + 'static) -> Self {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let conns = Arc::new(AtomicUsize::new(0));
        let answer = Arc::new(answer);
        let (seen2, conns2) = (seen.clone(), conns.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = l.accept().await else {
                    return;
                };
                conns2.fetch_add(1, Ordering::SeqCst);
                let (seen, answer) = (seen2.clone(), answer.clone());
                tokio::spawn(async move {
                    loop {
                        let Some(req) = read_request(&mut sock).await else {
                            return;
                        };
                        seen.lock().unwrap().push(req.clone());
                        let (code, headers, body) = answer(&req);
                        let mut out = format!("HTTP/1.1 {code} X\r\ncontent-length: {}\r\n", body.len());
                        for (k, v) in headers {
                            let _ = write!(out, "{k}: {v}\r\n");
                        }
                        out.push_str("\r\n");
                        out.push_str(&body);
                        if sock.write_all(out.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        Self { addr, seen, conns }
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

async fn read_request(sock: &mut tokio::net::TcpStream) -> Option<Seen> {
    let mut buf = Vec::new();
    let mut byte = [0_u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        if sock.read(&mut byte).await.ok()? == 0 {
            return None;
        }
        buf.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&buf).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_owned();
    let path = first.next()?.to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect();
    let len: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0_u8; len];
    sock.read_exact(&mut body).await.ok()?;
    Some(Seen {
        method,
        path,
        headers,
    })
}

fn json_reply(body: &str) -> Reply {
    (
        200,
        vec![("content-type", "application/json".to_owned())],
        body.to_owned(),
    )
}

/// A tunnel printer config routed to `mock`, with `u1:s3cretpw` in the secrets.
fn routed(id: &str, plugin: &str, mock: &Mock) -> (PrinterConfig, MemorySecrets) {
    let host = format!("{id}{DOMAIN}");
    add_route(&host, mock.addr);
    let cfg = tunnel_cfg(id, plugin, &host);
    let secrets = MemorySecrets::new();
    secrets.set(&format!("{id}-tunnel"), "u1:s3cretpw").unwrap();
    (cfg, secrets)
}

const BASIC: &str = "Basic dTE6czNjcmV0cHc="; // base64("u1:s3cretpw")

// ---------------------------------------------------------------- transport

#[tokio::test]
async fn the_credential_goes_out_as_basic_authorization_only() {
    let mock = Mock::start(|_| json_reply("{}")).await;
    let (cfg, secrets) = routed("auth1", "octoprint", &mock);
    let t = Tunnel::open(&cfg, &secrets).await.unwrap();
    crate::http::send("auth1", t.client().get(format!("{}/api/version", t.base())))
        .await
        .unwrap();
    let seen = mock.seen();
    assert_eq!(seen[0].header("authorization"), Some(BASIC));
    assert_eq!(seen[0].header("x-api-key"), None);
    assert_eq!(
        seen[0].header("host"),
        Some(format!("auth1{DOMAIN}:{}", mock.addr.port()).as_str())
    );
}

#[tokio::test]
async fn without_a_stored_credential_nothing_is_sent() {
    let mock = Mock::start(|_| json_reply("{}")).await;
    let (cfg, _) = routed("noauth", "octoprint", &mock);
    let e = Tunnel::open(&cfg, &MemorySecrets::new()).await.err().unwrap();
    assert_eq!(e.tunnel_problem(), Some(TunnelProblem::NoAccess));
    assert_eq!(e.code(), ErrorCode::Auth);
    assert_eq!(mock.conns.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_redirect_is_never_followed() {
    let elsewhere = Mock::start(|_| json_reply("{}")).await;
    let target = format!("http://127.0.0.1:{}/steal", elsewhere.addr.port());
    let mock = Mock::start(move |_| (302, vec![("location", target.clone())], String::new())).await;
    let (cfg, secrets) = routed("redir", "octoprint", &mock);
    let t = Tunnel::open(&cfg, &secrets).await.unwrap();
    let e = crate::http::send("redir", t.client().get(format!("{}/api/version", t.base())))
        .await
        .unwrap_err();
    assert!(e.to_string().contains("redirect"), "{e}");
    assert_eq!(
        elsewhere.conns.load(Ordering::SeqCst),
        0,
        "the redirect was followed"
    );
    // The driver refuses the same way.
    let e = crate::drivers::OctoPrintConnector::new(Arc::new(MemoryGate::new()))
        .connect(&cfg, &secrets)
        .await
        .err()
        .unwrap();
    assert!(e.to_string().contains("redirect"), "{e}");
    assert_eq!(
        elsewhere.conns.load(Ordering::SeqCst),
        0,
        "the redirect was followed"
    );
}

#[tokio::test]
async fn tunnel_status_codes_read_as_plain_problems() {
    let mock = Mock::start(|r| {
        let code = r.path.trim_start_matches('/').parse().unwrap_or(200);
        (code, vec![], String::new())
    })
    .await;
    let (cfg, secrets) = routed("codes", "octoprint", &mock);
    let t = Tunnel::open(&cfg, &secrets).await.unwrap();
    for (code, problem, want) in [
        (401, TunnelProblem::AccessRemoved, ErrorCode::Auth),
        (481, TunnelProblem::DataLimit, ErrorCode::TunnelDataLimit),
        (482, TunnelProblem::NotConnected, ErrorCode::Unreachable),
        (483, TunnelProblem::TimedOut, ErrorCode::Timeout),
    ] {
        let e = crate::http::send("codes", t.client().get(format!("{}/{code}", t.base())))
            .await
            .unwrap_err();
        assert_eq!(e.tunnel_problem(), Some(problem), "{code}");
        assert_eq!(e.code(), want, "{code}");
        let text = e.to_string();
        assert!(text.contains("Obico") && !text.contains("HTTP"), "{code}: {text}");
    }
}

#[tokio::test]
async fn the_same_codes_from_a_lan_printer_are_not_tunnel_problems() {
    let mock = Mock::start(|r| {
        let code = r.path.trim_start_matches('/').parse().unwrap_or(200);
        (code, vec![], String::new())
    })
    .await;
    let mut lan = tunnel_cfg("lan", "octoprint", "127.0.0.1");
    lan.tunnel = None;
    let client = crate::http::client(&lan).unwrap();
    for code in [481, 482, 483] {
        let e = crate::http::send("lan", client.get(format!("http://{}/{code}", mock.addr)))
            .await
            .unwrap_err();
        assert_eq!(e.tunnel_problem(), None, "{code}");
    }
    let e = crate::http::send("lan", client.get(format!("http://{}/401", mock.addr)))
        .await
        .unwrap_err();
    assert!(matches!(e, Error::Auth { .. }), "{e}");
}

// ---------------------------------------------------------------- usage and polling

fn usage(total: f64, cap: f64) -> TunnelUsage {
    TunnelUsage {
        total_bytes: total,
        monthly_cap_bytes: cap,
        reset_in_seconds: None,
    }
}

#[test]
fn status_is_read_every_15_to_30_seconds_by_what_is_left() {
    const MB: f64 = 1_000_000.0;
    assert_eq!(poll_interval(None), MAX_POLL);
    assert_eq!(poll_interval(Some(&usage(5000.0 * MB, -1.0))), MIN_POLL);
    assert_eq!(poll_interval(Some(&usage(0.0, 300.0 * MB))), MIN_POLL);
    assert_eq!(poll_interval(Some(&usage(150.0 * MB, 300.0 * MB))), MIN_POLL);
    let mid = poll_interval(Some(&usage(210.0 * MB, 300.0 * MB)));
    assert!(mid > MIN_POLL && mid < MAX_POLL, "{mid:?}");
    assert_eq!(poll_interval(Some(&usage(270.0 * MB, 300.0 * MB))), MAX_POLL);
    assert_eq!(poll_interval(Some(&usage(400.0 * MB, 300.0 * MB))), MAX_POLL);
    assert_eq!(poll_interval(Some(&usage(0.0, 0.0))), MAX_POLL);
    assert_eq!(MIN_POLL, Duration::from_secs(15));
    assert_eq!(MAX_POLL, Duration::from_secs(30));
}

#[test]
fn the_usage_reply_reads_total_cap_and_reset() {
    let v = serde_json::json!({ "total": 1234, "monthly_cap": -1, "reset_in_seconds": 99 });
    let u = TunnelUsage::from_json(&v).unwrap();
    assert!(u.unlimited());
    assert_eq!(u.left_bytes(), None);
    assert_eq!(u.reset_in_seconds, Some(99));
    let u = TunnelUsage::from_json(&serde_json::json!({ "total": 100, "monthly_cap": 300 })).unwrap();
    assert_eq!(u.left_bytes(), Some(200.0));
    assert!(TunnelUsage::from_json(&serde_json::json!({ "total": 1 })).is_none());
}

/// A mock whose `/_tsd_/tunnelusage/` answers `usage`.
async fn usage_mock(usage: Option<&'static str>) -> Mock {
    Mock::start(move |r| match (r.path.as_str(), usage) {
        ("/_tsd_/tunnelusage/", Some(u)) => json_reply(u),
        ("/_tsd_/tunnelusage/", None) => (404, vec![], String::new()),
        _ => json_reply("{}"),
    })
    .await
}

#[tokio::test]
async fn an_upload_that_does_not_fit_in_what_is_left_is_refused_first() {
    let mock = usage_mock(Some(r#"{"total": 290000000, "monthly_cap": 300000000}"#)).await;
    let (cfg, secrets) = routed("up1", "octoprint", &mock);
    let t = Tunnel::open(&cfg, &secrets).await.unwrap();
    t.check_upload(5_000_000).await.unwrap();
    let e = t.check_upload(20_000_000).await.unwrap_err();
    assert_eq!(e.tunnel_problem(), Some(TunnelProblem::FileOverDataLimit));
    assert_eq!(e.code(), ErrorCode::TunnelDataLimit);

    let mock = usage_mock(Some(r#"{"total": 300000000, "monthly_cap": 300000000}"#)).await;
    let (cfg, secrets) = routed("up2", "octoprint", &mock);
    let t = Tunnel::open(&cfg, &secrets).await.unwrap();
    let e = t.check_upload(1).await.unwrap_err();
    assert_eq!(e.tunnel_problem(), Some(TunnelProblem::DataLimit));

    let mock = usage_mock(Some(r#"{"total": 9000000000, "monthly_cap": -1}"#)).await;
    let (cfg, secrets) = routed("up3", "octoprint", &mock);
    Tunnel::open(&cfg, &secrets)
        .await
        .unwrap()
        .check_upload(500_000_000)
        .await
        .unwrap();

    // A tunnel that does not report usage still enforces its own cap (481), so the upload goes on.
    let mock = usage_mock(None).await;
    let (cfg, secrets) = routed("up4", "octoprint", &mock);
    Tunnel::open(&cfg, &secrets)
        .await
        .unwrap()
        .check_upload(1)
        .await
        .unwrap();
}

#[tokio::test]
async fn status_through_a_tunnel_is_read_at_most_once_per_interval() {
    let mock = usage_mock(Some(r#"{"total": 0, "monthly_cap": -1}"#)).await;
    let (cfg, secrets) = routed("cache", "octoprint", &mock);
    let t = Tunnel::open(&cfg, &secrets).await.unwrap();
    let fetches = AtomicUsize::new(0);
    let fetch = || async {
        fetches.fetch_add(1, Ordering::SeqCst);
        Ok(PrinterStatus::offline("cache"))
    };
    for _ in 0..5 {
        t.status(fetch).await.unwrap();
    }
    assert_eq!(fetches.load(Ordering::SeqCst), 1);
    assert_eq!(t.poll_interval(), MIN_POLL, "the usage was read along the way");
    t.forget_status().await;
    t.status(fetch).await.unwrap();
    assert_eq!(fetches.load(Ordering::SeqCst), 2);
    let usage_reads = mock
        .seen()
        .iter()
        .filter(|s| s.path == "/_tsd_/tunnelusage/")
        .count();
    assert_eq!(
        usage_reads, 1,
        "usage is refreshed every ten minutes, not every reading"
    );
}

// ---------------------------------------------------------------- drivers

fn octoprint_mock() -> impl Fn(&Seen) -> Reply + Send + Sync + 'static {
    |r| match r.path.as_str() {
        "/api/version" => json_reply(r#"{"api": "0.1", "server": "1.10.0"}"#),
        "/api/printer" => json_reply(
            r#"{"state": {"flags": {"operational": true}}, "temperature": {"tool0": {"actual": 21.0, "target": 0.0}, "bed": {"actual": 20.0, "target": 0.0}}}"#,
        ),
        "/api/job" => json_reply(r#"{"job": {"file": {"name": null}}, "progress": {"completion": null}}"#),
        "/_tsd_/tunnelusage/" => json_reply(r#"{"total": 290000000, "monthly_cap": 300000000}"#),
        "/api/files/local" => (
            201,
            vec![("content-type", "application/json".to_owned())],
            "{}".to_owned(),
        ),
        _ => (404, vec![], String::new()),
    }
}

#[tokio::test]
async fn octoprint_works_through_the_tunnel_with_no_printer_key_and_no_camera() {
    let mock = Mock::start(octoprint_mock()).await;
    let (cfg, secrets) = routed("octo", "octoprint", &mock);
    let gate = Arc::new(MemoryGate::new());
    let s = crate::drivers::OctoPrintConnector::new(gate.clone())
        .connect(&cfg, &secrets)
        .await
        .unwrap();
    assert_eq!(s.status().await.unwrap().state, PrinterState::Idle);
    assert!(!s.capabilities().contains(&crate::Capability::Camera));
    assert!(s.snapshot().await.unwrap().is_none());
    for r in mock.seen() {
        assert_eq!(r.header("authorization"), Some(BASIC), "{}", r.path);
        assert_eq!(r.header("x-api-key"), None, "{}", r.path);
        assert_ne!(r.path, "/api/settings", "the camera settings were read");
    }

    // 20 MB does not fit in the 10 MB left: refused before the upload is sent.
    let data = vec![b';'; 20_000_000];
    let file = crate::JobFile {
        name: "big.gcode".to_owned(),
        kind: crate::JobKind::Gcode,
        sha256: "00".repeat(32),
        data,
    };
    let token = gate.mint(
        crate::Action::Upload,
        "octo",
        &crate::params::upload("octo", &file.name, &file.sha256),
    );
    let e = s.upload(file, &token).await.unwrap_err();
    assert_eq!(e.tunnel_problem(), Some(TunnelProblem::FileOverDataLimit));
    let paths: Vec<String> = mock
        .seen()
        .into_iter()
        .map(|r| format!("{} {}", r.method, r.path))
        .collect();
    assert!(paths.iter().any(|p| p == "GET /_tsd_/tunnelusage/"), "{paths:?}");
    assert!(!paths.iter().any(|p| p == "POST /api/files/local"), "{paths:?}");
}

#[tokio::test]
async fn moonraker_through_a_tunnel_reports_the_tunnel_problem_not_a_login_one() {
    let mock = Mock::start(|r| match r.path.as_str() {
        "/server/info" => (401, vec![], String::new()),
        _ => json_reply(r#"{"result": {"login_required": false}}"#),
    })
    .await;
    let (cfg, secrets) = routed("klip", "moonraker", &mock);
    let e = crate::drivers::MoonrakerConnector::new(Arc::new(MemoryGate::new()))
        .connect(&cfg, &secrets)
        .await
        .err()
        .unwrap();
    assert_eq!(e.tunnel_problem(), Some(TunnelProblem::AccessRemoved), "{e}");
    assert!(
        !mock.seen().iter().any(|r| r.path == "/access/info"),
        "it asked the printer about logins"
    );

    let mock = Mock::start(|_| (482, vec![], String::new())).await;
    let (cfg, secrets) = routed("klip2", "moonraker", &mock);
    let e = crate::drivers::MoonrakerConnector::new(Arc::new(MemoryGate::new()))
        .connect(&cfg, &secrets)
        .await
        .err()
        .unwrap();
    assert_eq!(e.tunnel_problem(), Some(TunnelProblem::NotConnected), "{e}");
    assert_eq!(mock.seen()[0].header("authorization"), Some(BASIC));
}

// ---------------------------------------------------------------- redaction

#[test]
fn user_names_and_passwords_are_taken_out_of_urls_in_text() {
    for (input, want) in [
        (
            "GET https://u1:s3cretpw@abc.tunnels.app.obico.io/api failed",
            "GET https://abc.tunnels.app.obico.io/api failed",
        ),
        (
            "https://u1:s3cretpw@abc.tunnels.app.obico.io",
            "https://abc.tunnels.app.obico.io",
        ),
        (
            "a http://x:y@h/ and wss://p:q@h2:443/z \"https://m:n@h3\"",
            "a http://h/ and wss://h2:443/z \"https://h3\"",
        ),
        (
            "pw with slash https://u1:pa/ss@h.example/x",
            "pw with slash https://h.example/x",
        ),
        ("no url here: u1:s3cretpw", "no url here: u1:s3cretpw"),
        (
            "https://abc.tunnels.app.obico.io/x",
            "https://abc.tunnels.app.obico.io/x",
        ),
        ("", ""),
    ] {
        assert_eq!(redact_userinfo(input), want, "{input}");
    }
}

#[test]
fn error_text_never_carries_a_tunnel_credential() {
    let url = "https://u1:s3cretpw@abc.tunnels.app.obico.io/api/job";
    for e in [
        Error::unreachable("p", format!("connect to {url} refused")),
        Error::protocol("p", format!("bad reply from {url}")),
        Error::timeout("p", url),
        Error::tls("p", url),
    ] {
        let text = e.to_string();
        assert!(!text.contains("s3cretpw") && !text.contains("u1:"), "{text}");
        assert!(text.contains("abc.tunnels.app.obico.io"), "{text}");
    }
}

// ---------------------------------------------------------------- the paste box's rules

/// The words of each refusal in [`TunnelEndpoint::parse`], by the reason the shared fixture names.
fn reason_of(message: &str) -> &'static str {
    for (needle, reason) in [
        ("must start with https://", "scheme"),
        ("path, query or fragment", "path"),
        ("a port or an IP address", "port"),
        ("the host is not", "host"),
        ("user name", "userinfo"),
        ("password", "userinfo"),
    ] {
        if message.contains(needle) {
            return reason;
        }
    }
    "unknown"
}

/// The app's paste box (`parseTunnelEndpoint` in packages/contracts) runs the same cases, so the two
/// parsers accept and refuse exactly the same addresses, for the same reason.
#[test]
fn every_shared_paste_box_case_parses_the_same_here() {
    let doc: serde_json::Value =
        serde_json::from_str(include_str!("../../fixtures/tunnel-endpoints.json")).unwrap();
    let cases = doc["cases"].as_array().unwrap();
    assert!(cases.len() >= 40, "the fixture lost its cases");
    for c in cases {
        let input = c["input"].as_str().unwrap();
        match (
            TunnelEndpoint::parse(TunnelKind::Obico, input),
            c["problem"].as_str(),
        ) {
            (Ok(ep), None) => {
                assert_eq!(Some(ep.host.as_str()), c["host"].as_str(), "{input:?}");
                assert_eq!(
                    ep.credential().is_some(),
                    c["credential"].as_bool().unwrap(),
                    "{input:?}"
                );
            }
            (Err(e), Some(want)) => {
                let text = e.to_string();
                assert_eq!(reason_of(&text), want, "{input:?}: {text}");
                // An error never repeats the address, so a password in it never reaches a log.
                if input.contains("u:p") {
                    assert!(!text.contains("u:p"), "{text}");
                }
            }
            (got, want) => panic!("{input:?}: parsed {got:?}, the fixture says {want:?}"),
        }
    }
}

// ---------------------------------------------------------------- the tunnel report

/// An OctoPrint mock behind a tunnel, `printing` or idle, with this month's usage and a failure score.
fn report_mock(printing: bool, usage: &'static str) -> impl Fn(&Seen) -> Reply + Send + Sync + 'static {
    move |r| match r.path.as_str() {
        "/api/version" => json_reply(r#"{"api": "0.1", "server": "1.10.0"}"#),
        "/api/printer" => json_reply(if printing {
            r#"{"state": {"flags": {"operational": true, "printing": true}}, "temperature": {"tool0": {"actual": 210.0, "target": 210.0}}}"#
        } else {
            r#"{"state": {"flags": {"operational": true}}, "temperature": {"tool0": {"actual": 21.0, "target": 0.0}}}"#
        }),
        "/api/job" => json_reply(if printing {
            r#"{"job": {"file": {"name": "cube.gcode"}}, "progress": {"completion": 40.0, "printTimeLeft": 600}}"#
        } else {
            r#"{"job": {"file": {"name": null}}, "progress": {"completion": null}}"#
        }),
        "/_tsd_/tunnelusage/" => json_reply(usage),
        "/_tsd_/prediction/" => json_reply(r#"{"normalized_p": 0.12}"#),
        _ => (404, vec![], String::new()),
    }
}

async fn octo_session(id: &str, mock: &Mock) -> Box<dyn crate::PrinterSession> {
    let (cfg, secrets) = routed(id, "octoprint", mock);
    crate::drivers::OctoPrintConnector::new(Arc::new(MemoryGate::new()))
        .connect(&cfg, &secrets)
        .await
        .unwrap()
}

fn reads(mock: &Mock, path: &str) -> usize {
    mock.seen().iter().filter(|s| s.path == path).count()
}

#[tokio::test]
async fn the_report_has_the_month_s_data_and_no_score_while_idle() {
    let mock = Mock::start(report_mock(
        false,
        r#"{"total": 120000000, "monthly_cap": 300000000, "reset_in_seconds": 86400}"#,
    ))
    .await;
    let s = octo_session("rep1", &mock).await;
    s.status().await.unwrap();
    let r = s.tunnel().await.expect("a tunnel printer reports its tunnel");
    assert_eq!(r.kind, TunnelKind::Obico);
    assert_eq!(r.problem, None);
    assert_eq!(r.connected, Some(true));
    let u = r.usage.unwrap();
    assert_eq!(
        (u.used_bytes, u.cap_bytes, u.left_bytes, u.unlimited),
        (120_000_000, Some(300_000_000), Some(180_000_000), false)
    );
    assert_eq!(u.reset_in_seconds, Some(86_400));
    assert_eq!(r.prediction, None, "nothing prints, so no failure score is read");
    assert_eq!(reads(&mock, "/_tsd_/prediction/"), 0);
    // Shape the app and clients read.
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["kind"], "obico");
    assert_eq!(v["usage"]["usedBytes"], 120_000_000);
    assert_eq!(v["usage"]["leftBytes"], 180_000_000);
    assert_eq!(v["usage"]["resetInSeconds"], 86_400);
    assert!(v["prediction"].is_null());

    // Asked again at once, the report reuses what it read: a card that refreshes costs no tunnel data.
    let before = reads(&mock, "/_tsd_/tunnelusage/");
    s.tunnel().await.unwrap();
    assert_eq!(reads(&mock, "/_tsd_/tunnelusage/"), before);
}

#[tokio::test]
async fn while_printing_the_report_reads_the_failure_score_once_a_minute() {
    let mock = Mock::start(report_mock(true, r#"{"total": 5, "monthly_cap": -1}"#)).await;
    let s = octo_session("rep2", &mock).await;
    s.status().await.unwrap();
    let r = s.tunnel().await.unwrap();
    let u = r.usage.unwrap();
    assert!(u.unlimited);
    assert_eq!((u.cap_bytes, u.left_bytes), (None, None));
    let p = r.prediction.expect("a printing printer has a score");
    assert!((p.score - 0.12).abs() < 1e-9);
    s.tunnel().await.unwrap();
    assert_eq!(
        reads(&mock, "/_tsd_/prediction/"),
        1,
        "the score is kept for a minute"
    );
    for r in mock.seen() {
        assert_eq!(r.header("authorization"), Some(BASIC), "{}", r.path);
    }
}

#[test]
fn a_failure_score_outside_0_to_1_or_missing_is_no_score() {
    for (body, want) in [
        (r#"{"normalized_p": 0.5}"#, Some(0.5)),
        (r#"{"normalized_p": 0}"#, Some(0.0)),
        (r#"{"normalized_p": 1}"#, Some(1.0)),
        (r#"{"normalized_p": 1.5}"#, None),
        (r#"{"normalized_p": -0.1}"#, None),
        (r#"{"normalized_p": "0.5"}"#, None),
        (r#"{"p": 0.5}"#, None),
        ("null", None),
    ] {
        let v: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(Prediction::from_json(&v).map(|p| p.score), want, "{body}");
    }
}

#[tokio::test]
async fn the_report_names_the_tunnel_s_problem_from_the_last_reading() {
    let mock = Mock::start(|r| match r.path.as_str() {
        "/api/version" => json_reply(r#"{"api": "0.1"}"#),
        "/_tsd_/tunnelusage/" => json_reply(r#"{"total": 300000000, "monthly_cap": 300000000}"#),
        _ => (481, vec![], String::new()),
    })
    .await;
    let s = octo_session("rep3", &mock).await;
    let e = s.status().await.unwrap_err();
    assert_eq!(e.tunnel_problem(), Some(TunnelProblem::DataLimit));
    let r = s.tunnel().await.unwrap();
    assert_eq!(r.problem, Some(TunnelProblem::DataLimit));
    assert_eq!(r.connected, Some(false));
    assert_eq!(r.usage.unwrap().left_bytes, Some(0));
    assert_eq!(serde_json::to_value(&r).unwrap()["problem"], "data_limit");
}

#[tokio::test]
async fn a_lan_printer_has_no_tunnel_report() {
    let mock = Mock::start(octoprint_mock()).await;
    let cfg: PrinterConfig = serde_json::from_value(serde_json::json!({
        "id": "lan1", "name": "lan1", "plugin": "octoprint", "host": "127.0.0.1", "port": mock.addr.port(),
    }))
    .unwrap();
    let s = crate::drivers::OctoPrintConnector::new(Arc::new(MemoryGate::new()))
        .connect(&cfg, &MemorySecrets::new())
        .await
        .unwrap();
    assert!(s.tunnel().await.is_none());
}
