// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Files and links the system hands to the app: a double-clicked model or project, and "Open in" links
//! (`slicerx://open?url=https://...`, with the edition's own scheme in a white-label build). Files join the same registry the open dialog uses, so the webview
//! still never names a path. A link's file is downloaded to the app's cache folder first: https only, a size
//! limit, and only the model extensions below.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::files::{FileRef, OpenFiles};

/// What the app opens. Everything else the system passes is ignored.
const EXTENSIONS: [&str; 9] = [
    "stl", "3mf", "sx3mf", "sxlock", "gcode", "obj", "amf", "step", "stp",
];
const MAX_DOWNLOAD: u64 = 256 * 1024 * 1024;

/// Files that arrived before the webview was listening.
#[derive(Default)]
pub struct Pending(Mutex<Vec<FileRef>>);

/// Sign-in links (`slicerx://auth/callback?code=...`) waiting for the page to finish them.
#[derive(Default)]
pub struct PendingAuth(Mutex<Vec<String>>);

/// True for this edition's sign-in callback link, which the page exchanges for a session.
pub fn is_auth_callback(url: &str) -> bool {
    is_auth_callback_for(&crate::brand::get().scheme, url)
}

fn is_auth_callback_for(scheme: &str, url: &str) -> bool {
    let Some(rest) = url
        .strip_prefix(scheme)
        .and_then(|r| r.strip_prefix("://auth/callback"))
    else {
        return false;
    };
    rest.is_empty() || rest.starts_with(['?', '#']) || rest.starts_with("/?")
}

/// Holds a sign-in link for the page and brings the window forward, since the link came from the browser.
fn hand_over_sign_in(app: &AppHandle, url: String) {
    {
        let state = app.state::<PendingAuth>();
        let mut pending = state.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // A cold start can see the same link twice (the launch arguments and the deep link plugin).
        if !pending.contains(&url) {
            pending.push(url);
        }
    }
    let _ = app.emit("sx-auth-callback", ());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn wanted(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// The https address in an "Open in" link with this edition's scheme, or None for anything else.
pub fn link_target(url: &str) -> Option<String> {
    link_target_for(&crate::brand::get().scheme, url)
}

fn link_target_for(scheme: &str, url: &str) -> Option<String> {
    let rest = url.strip_prefix(scheme)?.strip_prefix("://open")?;
    let rest = rest.strip_prefix("/?").or_else(|| rest.strip_prefix('?'))?;
    let (_, value) = rest
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == "url")?;
    let decoded = percent_decode(value)?;
    let target = decoded.strip_prefix("https://")?;
    // A host is required, and a login in the address would be sent along.
    let host = target.split(['/', '?', '#']).next().unwrap_or("");
    (!host.is_empty() && !host.contains('@')).then_some(decoded)
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The file name a link's address ends in, when it is one of ours.
fn name_from(target: &str) -> Option<String> {
    let path = target.strip_prefix("https://")?.split(['?', '#']).next()?;
    let name = path.rsplit('/').next()?;
    let ok = !name.is_empty()
        && name.len() <= 120
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._- ()".contains(c))
        && !name.starts_with('.')
        && wanted(Path::new(name));
    ok.then(|| name.to_owned())
}

fn register(app: &AppHandle, path: PathBuf) -> FileRef {
    let files = app.state::<OpenFiles>();
    files.add(path)
}

fn announce(app: &AppHandle, refs: Vec<FileRef>) {
    if refs.is_empty() {
        return;
    }
    let pending = app.state::<Pending>();
    // Held until the webview asks, then the event is for later arrivals; both paths hand over each file once.
    pending
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .extend(refs.iter().cloned());
    let _ = app.emit("sx-open-files", ());
}

/// Handles what the system passed: file paths, `file://` URLs and "Open in" links.
pub fn handle(app: &AppHandle, items: Vec<String>) {
    let mut refs = Vec::new();
    for item in items {
        if is_auth_callback(&item) {
            hand_over_sign_in(app, item);
            continue;
        }
        if let Some(target) = link_target(&item) {
            let app = app.clone();
            std::thread::spawn(move || {
                match if confirmed(&app, &target) {
                    download(&app, &target).map(Some)
                } else {
                    Ok(None)
                } {
                    Ok(Some(path)) => announce(&app, vec![register(&app, path)]),
                    Ok(None) => {}
                    Err(e) => {
                        let _ = app.emit("sx-open-failed", e);
                    }
                }
            });
            continue;
        }
        let path = item
            .strip_prefix("file://")
            .map(|p| PathBuf::from(percent_decode(p).unwrap_or_else(|| p.to_owned())))
            .unwrap_or_else(|| PathBuf::from(&item));
        if path.is_file() && wanted(&path) {
            refs.push(register(app, path));
        }
    }
    announce(app, refs);
}

/// A link may only fetch a model: STL, 3MF or SlicerX project.
const LINK_EXTENSIONS: [&str; 3] = ["stl", "3mf", "sx3mf"];

fn link_name(name: &str) -> bool {
    LINK_EXTENSIONS.contains(
        &Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
    )
}

/// The host of an https address, lower case, with no port, login or brackets. Only the default port is allowed.
fn host_of(target: &str) -> Option<String> {
    let rest = target.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.contains('@') || authority.is_empty() {
        return None;
    }
    let host = if let Some(v6) = authority.strip_prefix('[') {
        let (h, tail) = v6.split_once(']')?;
        if !(tail.is_empty() || tail == ":443") {
            return None;
        }
        h
    } else {
        match authority.split_once(':') {
            Some((h, "443")) => h,
            Some(_) => return None,
            None => authority,
        }
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// Public internet addresses only: nothing loopback, private, link-local, shared (CGNAT), multicast or unspecified.
pub fn is_public(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(v.is_loopback()
                || v.is_private()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_broadcast()
                || v.is_multicast()
                || v.is_documentation()
                || (o[0] == 100 && (64..128).contains(&o[1]))
                || o[0] == 0
                || o[0] >= 240)
        }
        IpAddr::V6(v) => {
            if let Some(m) = v.to_ipv4_mapped() {
                return is_public(IpAddr::V4(m));
            }
            let s = v.segments();
            !(v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80)
        }
    }
}

/// Resolves a link's host and refuses it unless every address is public. Returns the address to connect to, so a
/// second lookup (DNS rebinding) cannot change it.
pub fn vet(
    target: &str,
    resolve: &dyn Fn(&str) -> Vec<std::net::IpAddr>,
) -> Result<(String, std::net::IpAddr), String> {
    let host = host_of(target).ok_or("That link is not a plain https address.")?;
    let addrs = match host.parse::<std::net::IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => resolve(&host),
    };
    if addrs.is_empty() {
        return Err(format!("Could not find {host}."));
    }
    if addrs.iter().any(|a| !is_public(*a)) {
        return Err(format!(
            "{host} is not a public internet address, so {} will not fetch from it.",
            crate::brand::get().name
        ));
    }
    Ok((host, addrs[0]))
}

fn system_resolve(host: &str) -> Vec<std::net::IpAddr> {
    use std::net::ToSocketAddrs;
    (host, 443)
        .to_socket_addrs()
        .map(|it| it.map(|a| a.ip()).collect())
        .unwrap_or_default()
}

/// The Location of a redirect, resolved against the address it came from. Only absolute https and root relative paths.
pub fn redirect_target(from: &str, headers: &str) -> Option<String> {
    let line = headers
        .lines()
        .rev()
        .find_map(|l| {
            l.strip_prefix("location:")
                .or_else(|| l.strip_prefix("Location:"))
        })?
        .trim();
    if line.starts_with("https://") {
        Some(line.to_owned())
    } else if line.starts_with('/') && !line.starts_with("//") {
        let host_end = from
            .strip_prefix("https://")?
            .find(['/', '?', '#'])
            .map_or(from.len(), |i| i + 8);
        Some(format!("{}{line}", &from[..host_end]))
    } else {
        None
    }
}

/// Whether the bytes are the model they claim to be: binary or text STL, or a zip (3MF) holding a model part.
pub fn looks_like_mesh(name: &str, bytes: &[u8]) -> bool {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "stl" => {
            let binary = bytes.len() >= 84 && {
                let n = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
                n > 0 && bytes.len() == 84 + n * 50
            };
            binary
                || (bytes.starts_with(b"solid")
                    && bytes.windows(5).any(|w| w == b"facet")
                    && bytes.windows(6).any(|w| w == b"vertex"))
        }
        "3mf" | "sx3mf" => {
            bytes.starts_with(b"PK\x03\x04") && bytes.windows(16).any(|w| w == b"3D/3dmodel.model")
        }
        _ => false,
    }
}

/// A new folder only this user can enter, for curl's header file. `mkdir` fails on a name that
/// exists, so nothing another local user planted in the shared temp folder (a symlink to one of the
/// person's files, say) is ever written through.
fn private_dir() -> Result<std::path::PathBuf, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    for _ in 0..16 {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sx-open-{}-{nanos}-{n}", std::process::id()));
        let mut b = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
        if b.create(&dir).is_ok() {
            return Ok(dir);
        }
    }
    Err("Could not download the file: no private temporary folder.".to_owned())
}

/// One https GET to a vetted address, without following redirects, reading at most the cap plus one byte. Returns
/// the status class, the body and the headers. Uses the system's curl so the app carries no second TLS stack.
fn fetch_once(host: &str, ip: std::net::IpAddr, target: &str) -> Result<(u16, Vec<u8>, String), String> {
    use std::io::Read;
    let dir = private_dir()?;
    let hdr = dir.join("headers");
    let mut curl = std::process::Command::new("curl");
    let mut child = crate::launch::no_window(&mut curl)
        .args([
            "--silent",
            "--show-error",
            "--globoff",
            "--proto",
            "=https",
            "--max-time",
            "120",
            "--write-out",
            "%{http_code}",
            "--resolve",
        ])
        .arg(format!("{host}:443:{ip}"))
        .arg("--dump-header")
        .arg(&hdr)
        .arg("--output")
        .arg("-")
        .arg(target)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| {
            let _ = std::fs::remove_dir_all(&dir);
            "Could not download the file: curl is not available.".to_owned()
        })?;
    let mut body = Vec::new();
    let mut out = child.stdout.take().ok_or("curl gave no output")?;
    // The status code follows the body (--write-out), so keep room for it.
    let read = (&mut out)
        .take(MAX_DOWNLOAD + 8)
        .read_to_end(&mut body)
        .map_err(|e| e.to_string());
    if body.len() as u64 > MAX_DOWNLOAD + 3 {
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!(
            "That file is larger than {} will download from a link.",
            crate::brand::get().name
        ));
    }
    read?;
    let _ = child.wait();
    let headers = std::fs::read_to_string(&hdr).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);
    if body.len() < 3 {
        return Err("Could not download the file from that link.".to_owned());
    }
    let code: u16 = String::from_utf8_lossy(&body[body.len() - 3..])
        .parse()
        .unwrap_or(0);
    body.truncate(body.len() - 3);
    Ok((code, body, headers))
}

/// Downloads a vetted model: every hop is https to a public address (resolved first and pinned), at most four
/// redirects, a size cap, and the bytes must look like the model their name says. Nothing is run or opened.
fn download(app: &AppHandle, target: &str) -> Result<PathBuf, String> {
    let name = name_from(target)
        .filter(|n| link_name(n))
        .ok_or("That link does not point to an STL or 3MF file.")?;
    let mut url = target.to_owned();
    let mut bytes = None;
    for _ in 0..5 {
        let (host, ip) = vet(&url, &system_resolve)?;
        let (code, body, headers) = fetch_once(&host, ip, &url)?;
        match code {
            200 => {
                bytes = Some(body);
                break;
            }
            301 | 302 | 303 | 307 | 308 => {
                url = redirect_target(&url, &headers).ok_or_else(|| {
                    format!(
                        "The link redirected somewhere {} will not follow.",
                        crate::brand::get().name
                    )
                })?
            }
            _ => return Err("Could not download the file from that link.".to_owned()),
        }
    }
    let bytes = bytes.ok_or("The link redirected too many times.")?;
    let product = &crate::brand::get().name;
    if bytes.len() as u64 > MAX_DOWNLOAD {
        return Err(format!(
            "That file is larger than {product} will download from a link."
        ));
    }
    if !looks_like_mesh(&name, &bytes) {
        return Err(format!("That file is not a model {product} can read."));
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("opened");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(&name);
    std::fs::write(&out, bytes).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Asks first, naming the whole host and the file. Nothing is fetched unless the person says Open.
fn confirmed(app: &AppHandle, target: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let host = host_of(target).unwrap_or_else(|| "an unknown site".to_owned());
    let name = name_from(target).unwrap_or_default();
    app.dialog()
        .message(format!(
            "Open this model from {host}?\n\n{name}\n\nA web page asked {} to download this file. It is checked and added to your plate; nothing is run.",
            crate::brand::get().name
        ))
        .title("Open from a link")
        .buttons(MessageDialogButtons::OkCancelCustom("Open".to_owned(), "Cancel".to_owned()))
        .blocking_show()
}

/// Files that arrived since the last call, for the webview to open.
#[tauri::command]
pub fn opened_take(state: State<'_, Pending>) -> Vec<FileRef> {
    std::mem::take(&mut *state.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner))
}

/// Sign-in links that arrived since the page last asked, each handed over once.
#[tauri::command]
pub fn auth_callback_take(state: State<'_, PendingAuth>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_in_links_with_the_edition_scheme_go_to_the_page() {
        assert!(is_auth_callback_for(
            "slicerx",
            "slicerx://auth/callback?code=abc"
        ));
        assert!(is_auth_callback_for(
            "slicerx",
            "slicerx://auth/callback/?code=abc"
        ));
        assert!(is_auth_callback_for(
            "slicerx",
            "slicerx://auth/callback?error=access_denied&error_description=expired"
        ));
        assert!(is_auth_callback_for(
            "acmeslicer",
            "acmeslicer://auth/callback?code=abc"
        ));
        // Another edition's scheme, an "Open in" link and look-alike paths are not sign-ins.
        assert!(!is_auth_callback_for(
            "slicerx",
            "acmeslicer://auth/callback?code=abc"
        ));
        assert!(!is_auth_callback_for(
            "slicerx",
            "slicerx://open?url=https://example.com/a.stl"
        ));
        assert!(!is_auth_callback_for(
            "slicerx",
            "slicerx://auth/callbackx?code=abc"
        ));
        assert!(!is_auth_callback_for(
            "slicerx",
            "https://slicerx.app/auth/callback?code=abc"
        ));
    }

    #[test]
    fn l8_the_header_file_lives_in_a_fresh_private_folder() {
        let a = private_dir().unwrap();
        let b = private_dir().unwrap();
        assert_ne!(a, b);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(std::fs::metadata(&a).unwrap().permissions().mode() & 0o777, 0o700);
        }
        assert!(std::fs::read_dir(&a).unwrap().next().is_none());
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn only_https_links_to_model_files_are_followed() {
        assert_eq!(
            link_target("slicerx://open?url=https%3A%2F%2Fexample.com%2Fa%2Fbox.3mf").as_deref(),
            Some("https://example.com/a/box.3mf")
        );
        assert_eq!(
            link_target("slicerx://open?name=x&url=https://example.com/b.stl").as_deref(),
            Some("https://example.com/b.stl")
        );
        assert_eq!(link_target("slicerx://open?url=http://example.com/b.stl"), None);
        assert_eq!(
            link_target("slicerx://open?url=https://user@example.com/b.stl"),
            None
        );
        assert_eq!(link_target("slicerx://open?url=file:///etc/passwd"), None);
        assert_eq!(link_target("slicerx://auth/callback?code=1"), None);
        assert_eq!(link_target("slicerxx://open?url=https://example.com/b.stl"), None);
    }

    #[test]
    fn a_white_label_build_opens_links_with_its_own_scheme() {
        let acme = crate::brand::tests::acme();
        assert_eq!(
            link_target_for(
                &acme.scheme,
                "acmeslicer://open?url=https%3A%2F%2Fexample.com%2Fa%2Fbox.3mf"
            )
            .as_deref(),
            Some("https://example.com/a/box.3mf")
        );
        assert_eq!(
            link_target_for(&acme.scheme, "acmeslicer://open/?url=https://example.com/b.stl").as_deref(),
            Some("https://example.com/b.stl")
        );
        // SlicerX's own links are not the fork's to open.
        assert_eq!(
            link_target_for(&acme.scheme, "slicerx://open?url=https://example.com/b.stl"),
            None
        );
        assert_eq!(
            link_target_for(&acme.scheme, "acmeslicer://open?url=http://example.com/b.stl"),
            None
        );
    }

    #[test]
    fn a_downloaded_name_is_plain_and_one_of_ours() {
        assert_eq!(
            name_from("https://example.com/m/box.STL?x=1").as_deref(),
            Some("box.STL")
        );
        assert_eq!(name_from("https://example.com/m/run.sh"), None);
        assert_eq!(name_from("https://example.com/m/.hidden.stl"), None);
        assert_eq!(name_from("https://example.com/"), None);
        assert!(wanted(Path::new("a.SX3MF")) && wanted(Path::new("b.sxlock")));
    }

    use std::net::IpAddr;
    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }
    fn dns(map: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Vec<IpAddr> {
        move |h| map.iter().filter(|(n, _)| *n == h).map(|(_, a)| ip(a)).collect()
    }

    #[test]
    fn private_loopback_and_local_addresses_are_refused() {
        for a in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fe80::1",
            "fd00::1",
            "::ffff:192.168.0.1",
            "224.0.0.1",
        ] {
            assert!(!is_public(ip(a)), "{a}");
        }
        for a in ["93.184.216.34", "2606:4700::1111"] {
            assert!(is_public(ip(a)), "{a}");
        }
    }

    #[test]
    fn a_host_that_resolves_to_a_private_address_is_refused_before_any_request() {
        let public = dns(&[("models.example", "93.184.216.34")]);
        assert_eq!(
            vet("https://models.example/a.stl", &public).unwrap().0,
            "models.example"
        );
        let rebinding = dns(&[("evil.example", "192.168.0.10")]);
        assert!(vet("https://evil.example/a.stl", &rebinding).is_err());
        let mixed = |_: &str| vec![ip("93.184.216.34"), ip("127.0.0.1")];
        assert!(vet("https://mixed.example/a.stl", &mixed).is_err());
        assert!(vet("https://127.0.0.1/a.stl", &public).is_err());
        assert!(vet("https://[::1]/a.stl", &public).is_err());
        assert!(vet("https://nothere.example/a.stl", &public).is_err());
        assert!(vet("https://models.example:8443/a.stl", &public).is_err());
        assert!(vet("http://models.example/a.stl", &public).is_err());
    }

    #[test]
    fn redirects_must_stay_https_and_are_resolved_against_the_origin() {
        assert_eq!(
            redirect_target(
                "https://a.example/x/y.stl",
                "HTTP/2 302\r\nlocation: https://b.example/z.stl\r\n"
            )
            .as_deref(),
            Some("https://b.example/z.stl")
        );
        assert_eq!(
            redirect_target("https://a.example/x/y.stl", "HTTP/2 302\r\nLocation: /z.stl\r\n").as_deref(),
            Some("https://a.example/z.stl")
        );
        assert_eq!(
            redirect_target("https://a.example/x", "location: http://b.example/z.stl\r\n"),
            None
        );
        assert_eq!(
            redirect_target("https://a.example/x", "location: //b.example/z.stl\r\n"),
            None
        );
        assert_eq!(
            redirect_target("https://a.example/x", "location: file:///etc/passwd\r\n"),
            None
        );
        // A redirect to a private address is caught by vet on the next hop.
        let to_private = dns(&[("intranet.example", "10.0.0.5")]);
        assert!(
            vet(
                &redirect_target(
                    "https://a.example/x",
                    "location: https://intranet.example/m.stl\r\n"
                )
                .unwrap(),
                &to_private
            )
            .is_err()
        );
    }

    #[test]
    fn only_model_bytes_pass_and_only_model_names_are_fetched() {
        let mut stl = vec![0u8; 80];
        stl.extend_from_slice(&1u32.to_le_bytes());
        stl.extend_from_slice(&[0u8; 50]);
        assert!(looks_like_mesh("a.stl", &stl));
        assert!(!looks_like_mesh("a.stl", &stl[..100]));
        assert!(looks_like_mesh(
            "a.stl",
            b"solid x\nfacet normal 0 0 1\nvertex 0 0 0\nendsolid"
        ));
        assert!(!looks_like_mesh("a.stl", b"#!/bin/sh\nrm -rf /"));
        assert!(looks_like_mesh("a.3mf", b"PK\x03\x04....3D/3dmodel.model...."));
        assert!(!looks_like_mesh("a.3mf", b"PK\x03\x04 no model here"));
        assert!(!looks_like_mesh("a.gcode", b"G1 X1"));
        assert!(link_name("a.STL") && link_name("b.sx3mf") && !link_name("c.gcode") && !link_name("d.sh"));
    }

    #[test]
    fn the_host_shown_in_the_prompt_is_the_whole_host() {
        assert_eq!(
            host_of("https://Models.Example.com/a.stl").as_deref(),
            Some("models.example.com")
        );
        assert_eq!(host_of("https://user@evil.example/a.stl"), None);
        assert_eq!(
            host_of("https://good.example.evil.test/a.stl").as_deref(),
            Some("good.example.evil.test")
        );
    }
}
