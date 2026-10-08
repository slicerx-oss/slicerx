// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The agent bridge: lets an agent read and drive the running app the way a person would, through a running-app MCP
//! server (packages/app-bridge) that forwards to this endpoint. Dev and test builds only: the module exists only with
//! the `agent-bridge` Cargo feature, release builds never turn it on, and the release check
//! (apps/desktop/release/check-agent-bridge.mjs) fails a binary that carries it. See docs/agent-bridge.md.
//!
//! It starts only when `SX_AGENT_BRIDGE_PORT` is set (0 picks a free port), listens on 127.0.0.1 only, and every
//! request needs the per-run token written to `SX_AGENT_BRIDGE_TOKEN_FILE`, else `agent-bridge.json` in the app's data
//! folder. No debugging port, WebDriver or CDP is involved, so it works the same on macOS, Windows and Linux.
//!
//! The shell answers what only it can do: screenshots (shot.rs), opening a file by path and handing over a sign-in
//! link (the same code paths a double-clicked file and the deep link take), and writing the slice's G-code to a
//! folder only this user can open (private.rs). Everything else goes to the page (packages/app/src/agent-bridge) as an
//! event and comes back through `agent_bridge_reply`. Nothing here prints, sends to a printer or deletes anything.

mod http;
mod png;
mod private;
mod shot;
#[cfg(unix)]
mod signal;

use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};

pub use http::ToolError;

pub const PORT_VAR: &str = "SX_AGENT_BRIDGE_PORT";
pub const TOKEN_FILE_VAR: &str = "SX_AGENT_BRIDGE_TOKEN_FILE";
/// The event the page listens on for tool calls.
const EVENT: &str = "sx-agent-bridge";
/// Connections served at once; more wait for an answer of 503.
const MAX_CONNECTIONS: usize = 8;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 15 * 60_000;

/// Tools the page answers. Anything not listed here or in `SHELL_TOOLS` is refused before it reaches the page.
pub const PAGE_TOOLS: [&str; 15] = [
    "state",
    "toasts",
    "dialogs",
    "console",
    "network",
    "user",
    "element",
    "testids",
    "click",
    "fill",
    "press_key",
    "wait_for",
    "open_vault_design",
    "clear_plate",
    "slice",
];
/// Tools the shell answers itself.
pub const SHELL_TOOLS: [&str; 4] = ["screenshot", "open_file", "auth_callback", "export_gcode"];

/// Calls waiting for the page, and whether the page side is there to answer them.
#[derive(Default)]
pub struct Relay {
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, ToolError>>>>,
    next: AtomicU64,
    running: AtomicBool,
    page_ready: AtomicBool,
    app_ready: AtomicBool,
    token_file: Mutex<Option<(PathBuf, String)>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The port to listen on, from the environment: `None` leaves the bridge off.
pub fn port_from(value: Option<&str>) -> Result<Option<u16>, String> {
    match value.map(str::trim) {
        None | Some("") => Ok(None),
        Some(v) => v
            .parse::<u16>()
            .map(Some)
            .map_err(|_| format!("{PORT_VAR} must be a port number (0 picks a free one), not {v}")),
    }
}

/// A fresh token: 32 random bytes as hex.
fn new_token() -> Result<String, String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// Writes the connection file anew, readable only by this user (private.rs). A file or link already at the path is
/// removed first, never written through.
pub fn write_token_file(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    private::write_private(path, contents.as_bytes())
}

/// Starts the bridge when `SX_AGENT_BRIDGE_PORT` is set. Problems are reported on stderr and leave the app running
/// without it.
pub fn start(app: &AppHandle) {
    let port = match port_from(std::env::var(PORT_VAR).ok().as_deref()) {
        Ok(Some(p)) => p,
        Ok(None) => return,
        Err(e) => {
            eprintln!("sx-agent-bridge: {e}");
            return;
        }
    };
    if let Err(e) = listen(app, port) {
        eprintln!("sx-agent-bridge: not started: {e}");
    }
}

fn listen(app: &AppHandle, port: u16) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("127.0.0.1:{port}: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = new_token()?;
    let file = match std::env::var_os(TOKEN_FILE_VAR).filter(|v| !v.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("agent-bridge.json"),
    };
    let info = json!({
        "port": port,
        "token": token,
        "pid": std::process::id(),
        "app": crate::brand::get().name,
        "version": app.package_info().version.to_string(),
    });
    write_token_file(&file, &info.to_string()).map_err(|e| format!("{}: {e}", file.display()))?;
    // A normal quit removes the file (stop); on macOS and Linux a signal that ends the app does too.
    #[cfg(unix)]
    signal::remove_on_signal(&file, &token);
    let relay = app.state::<Relay>();
    *lock(&relay.token_file) = Some((file.clone(), token.clone()));
    relay.running.store(true, Ordering::SeqCst);
    eprintln!(
        "sx-agent-bridge: listening on 127.0.0.1:{port}; token in {}",
        file.display()
    );

    let app = app.clone();
    let token: Arc<str> = token.into();
    let active = Arc::new(AtomicUsize::new(0));
    std::thread::Builder::new()
        .name("sx-agent-bridge".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let (app, token, active) = (app.clone(), Arc::clone(&token), Arc::clone(&active));
                if active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                    active.fetch_sub(1, Ordering::SeqCst);
                    let _ = http::write_response(
                        &stream,
                        &http::Response::error(503, "busy", "too many calls at once"),
                    );
                    continue;
                }
                let _ = std::thread::Builder::new()
                    .name("sx-agent-bridge-call".into())
                    .spawn(move || {
                        connection(&app, stream, &token, port);
                        active.fetch_sub(1, Ordering::SeqCst);
                    });
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn connection(app: &AppHandle, stream: TcpStream, token: &str, port: u16) {
    // A request arrives at once; a slow or silent peer is dropped. Tool calls may then take as long as they need.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let _ = http::serve(
        &stream,
        token,
        port,
        || health(app),
        |tool, args| call(app, tool, args),
    );
}

fn health(app: &AppHandle) -> Value {
    let relay = app.state::<Relay>();
    json!({
        "app": crate::brand::get().name,
        "version": app.package_info().version.to_string(),
        "pid": std::process::id(),
        "platform": std::env::consts::OS,
        "pageReady": relay.page_ready.load(Ordering::SeqCst),
        "appReady": relay.app_ready.load(Ordering::SeqCst),
        "tools": PAGE_TOOLS.iter().chain(SHELL_TOOLS.iter()).collect::<Vec<_>>(),
    })
}

/// How long a call may take: the tool's own `timeoutMs` (clamped), else 30 seconds.
pub fn timeout_of(args: &Value) -> Duration {
    let ms = args
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1_000, MAX_TIMEOUT_MS);
    Duration::from_millis(ms)
}

fn call(app: &AppHandle, tool: &str, args: Value) -> Result<Value, ToolError> {
    match tool {
        "screenshot" => screenshot(app),
        "open_file" => open_file(app, &args),
        "auth_callback" => auth_callback(app, &args),
        "export_gcode" => export_gcode(app, &args),
        t if PAGE_TOOLS.contains(&t) => ask_page(app, t, args),
        t => Err(ToolError::new(
            "unknown_tool",
            format!("the bridge has no tool {t}"),
        )),
    }
}

/// Hands a call to the page and waits for its answer, a little longer than the page itself waits.
fn ask_page(app: &AppHandle, tool: &str, args: Value) -> Result<Value, ToolError> {
    let relay = app.state::<Relay>();
    if !relay.page_ready.load(Ordering::SeqCst) {
        return Err(ToolError::new(
            "page_unavailable",
            "the page side of the bridge has not started (a frontend built without SLICERX_AGENT_BRIDGE=1, or the page is still loading)",
        ));
    }
    let wait = timeout_of(&args) + Duration::from_secs(5);
    let id = relay.next.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = mpsc::channel();
    lock(&relay.pending).insert(id, tx);
    let sent = app.emit_to("main", EVENT, json!({ "id": id, "tool": tool, "args": args }));
    let out = match sent {
        Err(e) => Err(ToolError::new("page_unavailable", e.to_string())),
        Ok(()) => rx.recv_timeout(wait).unwrap_or_else(|_| {
            Err(ToolError::new(
                "timeout",
                format!("the page did not answer {tool} in time"),
            ))
        }),
    };
    lock(&relay.pending).remove(&id);
    out
}

/// The page's error codes the bridge passes on; anything else becomes `page_error`.
fn page_code(code: &str) -> &'static str {
    match code {
        "invalid_input" => "invalid_input",
        "not_found" => "not_found",
        "refused" => "refused",
        "timeout" => "timeout",
        "not_ready" => "not_ready",
        _ => "page_error",
    }
}

/// The page starts its side and learns whether the bridge runs; false means it stays quiet. It calls again with
/// `app: true` once the app has its host and is about to render, which health reports as `appReady`.
#[tauri::command]
pub fn agent_bridge_ready(app: Option<bool>, relay: State<'_, Relay>) -> bool {
    let running = relay.running.load(Ordering::SeqCst);
    if running {
        relay.page_ready.store(true, Ordering::SeqCst);
        if app == Some(true) {
            relay.app_ready.store(true, Ordering::SeqCst);
        }
    }
    running
}

/// The page's answer to one call.
#[tauri::command]
pub fn agent_bridge_reply(id: u64, ok: bool, value: Value, code: Option<String>, relay: State<'_, Relay>) {
    let Some(tx) = lock(&relay.pending).remove(&id) else {
        return;
    };
    let out = if ok {
        Ok(value)
    } else {
        let message = value.as_str().map_or_else(|| value.to_string(), str::to_owned);
        Err(ToolError::new(page_code(code.as_deref().unwrap_or("")), message))
    };
    let _ = tx.send(out);
}

/// Removes the connection file when the app quits, if it is still this run's (signal.rs does the same when a signal
/// ends the app on macOS and Linux).
pub fn stop(app: &AppHandle) {
    let Some(relay) = app.try_state::<Relay>() else {
        return;
    };
    if let Some((file, token)) = lock(&relay.token_file).take() {
        let ours = std::fs::read_to_string(&file).is_ok_and(|s| s.contains(&token));
        if ours {
            let _ = std::fs::remove_file(file);
        }
    }
}

fn screenshot(app: &AppHandle) -> Result<Value, ToolError> {
    let png =
        shot::capture(app, Duration::from_secs(20)).map_err(|e| ToolError::new("screenshot_failed", e))?;
    let (width, height) = png::size_of(&png).unwrap_or((0, 0));
    Ok(json!({
        "mimeType": "image/png",
        "width": width,
        "height": height,
        "bytes": png.len(),
        "data": base64::engine::general_purpose::STANDARD.encode(&png),
    }))
}

fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ToolError::new("invalid_input", format!("{key} is required")))
}

/// The checks before a path joins the plate: absolute, an existing file, and a type the app opens.
pub fn openable(path: &Path) -> Result<(), ToolError> {
    if !path.is_absolute() {
        return Err(ToolError::new("invalid_input", "give an absolute path"));
    }
    if !path.is_file() {
        return Err(ToolError::new(
            "not_found",
            format!("no file at {}", path.display()),
        ));
    }
    if !crate::opened::wanted(path) {
        return Err(ToolError::new(
            "invalid_input",
            "the app opens STL, 3MF, SX3MF, SXLOCK, G-code, OBJ, AMF and STEP files",
        ));
    }
    Ok(())
}

/// Opens a model or project by path, the way a double-clicked file arrives.
fn open_file(app: &AppHandle, args: &Value) -> Result<Value, ToolError> {
    let path = PathBuf::from(string_arg(args, "path")?);
    openable(&path)?;
    crate::opened::handle(app, vec![path.to_string_lossy().into_owned()]);
    Ok(json!({ "handedOver": true, "name": path.file_name().map(|n| n.to_string_lossy().into_owned()) }))
}

/// Hands a sign-in callback link to the page through the deep link's own path. The link is never logged or echoed.
fn auth_callback(app: &AppHandle, args: &Value) -> Result<Value, ToolError> {
    let url = string_arg(args, "url")?;
    if !crate::opened::is_auth_callback(url) {
        return Err(ToolError::new(
            "refused",
            "only this edition's sign-in callback link (<scheme>://auth/callback?...) is handed over",
        ));
    }
    crate::opened::handle(app, vec![url.to_owned()]);
    Ok(json!({ "handedOver": true }))
}

/// A file name for the export folder: the slice's own name, cut to safe characters, ending in .gcode or .bgcode.
pub fn export_name(name: &str) -> String {
    let base: String = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || "._- ()".contains(*c))
        .take(120)
        .collect();
    let base = base.trim_start_matches('.').trim();
    let lower = base.to_ascii_lowercase();
    if base.is_empty() {
        "plate.gcode".to_owned()
    } else if lower.ends_with(".gcode") || lower.ends_with(".bgcode") {
        base.to_owned()
    } else {
        format!("{base}.gcode")
    }
}

/// The folder exports go to: one per app run, in a folder only this user can open (`$XDG_RUNTIME_DIR` on Linux when
/// set, else the app's cache folder), never the shared temporary folder.
fn export_dir(app: &AppHandle) -> Result<PathBuf, ToolError> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| ToolError::new("write_failed", e.to_string()))?;
    let dir = private::export_base(cache)
        .join("slicerx-agent-bridge")
        .join(std::process::id().to_string());
    private::private_dir(&dir).map_err(|e| ToolError::new("write_failed", e.to_string()))?;
    Ok(dir)
}

/// Writes the G-code of the slice on screen to the export folder. The page names the slice and its file name (and
/// refuses a slice that is stale or unsafe to print, as the Export button does); the bytes come from the shell.
fn export_gcode(app: &AppHandle, args: &Value) -> Result<Value, ToolError> {
    let info = ask_page(app, "export_info", json!({}))?;
    let id = info
        .get("id")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<u32>().ok())
        .ok_or_else(|| {
            ToolError::new(
                "not_ready",
                "the slice on screen is not one this app sliced (cloud slices export from the app)",
            )
        })?;
    let bytes = app
        .state::<crate::slicing::Slicer>()
        .gcode(id)
        .ok_or_else(|| ToolError::new("not_found", "the slice's G-code is gone; slice again"))?;
    let name = export_name(
        args.get("name")
            .and_then(Value::as_str)
            .or_else(|| info.get("fileName").and_then(Value::as_str))
            .unwrap_or("plate.gcode"),
    );
    let path = export_dir(app)?.join(&name);
    private::write_private(&path, &bytes).map_err(|e| ToolError::new("write_failed", e.to_string()))?;
    Ok(json!({ "path": path.to_string_lossy(), "fileName": name, "bytes": bytes.len() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_port_variable_turns_the_bridge_on() {
        assert_eq!(port_from(None), Ok(None));
        assert_eq!(port_from(Some("")), Ok(None));
        assert_eq!(port_from(Some("0")), Ok(Some(0)));
        assert_eq!(port_from(Some(" 47700 ")), Ok(Some(47_700)));
        assert!(port_from(Some("70000")).is_err());
        assert!(port_from(Some("yes")).is_err());
    }

    #[test]
    fn tokens_are_long_random_hex() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn the_token_file_is_written_fresh_and_private() {
        let dir = std::env::temp_dir().join(format!("sx-bridge-test-{}", std::process::id()));
        let file = dir.join("nested").join("agent-bridge.json");
        write_token_file(&file, "first").unwrap();
        write_token_file(&file, "second").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "second");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn timeouts_default_and_clamp() {
        assert_eq!(timeout_of(&json!({})), Duration::from_secs(30));
        assert_eq!(timeout_of(&json!({ "timeoutMs": 5 })), Duration::from_secs(1));
        assert_eq!(
            timeout_of(&json!({ "timeoutMs": 120_000 })),
            Duration::from_secs(120)
        );
        assert_eq!(
            timeout_of(&json!({ "timeoutMs": u64::MAX })),
            Duration::from_secs(15 * 60)
        );
        assert_eq!(
            timeout_of(&json!({ "timeoutMs": "soon" })),
            Duration::from_secs(30)
        );
    }

    #[test]
    fn page_error_codes_are_a_closed_set() {
        assert_eq!(page_code("refused"), "refused");
        assert_eq!(page_code("not_found"), "not_found");
        assert_eq!(page_code("anything else"), "page_error");
    }

    #[test]
    fn page_and_shell_tools_do_not_overlap() {
        for t in SHELL_TOOLS {
            assert!(!PAGE_TOOLS.contains(&t), "{t}");
        }
        // Nothing that prints, sends or deletes is a tool.
        for t in PAGE_TOOLS.iter().chain(SHELL_TOOLS.iter()) {
            assert!(
                !["print", "send", "delete", "remove", "archive"]
                    .iter()
                    .any(|bad| t.contains(bad)),
                "{t}"
            );
        }
    }

    #[test]
    fn only_absolute_existing_model_files_open() {
        let dir = std::env::temp_dir().join(format!("sx-bridge-open-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let model = dir.join("cube.stl");
        std::fs::write(&model, b"solid x\nendsolid x\n").unwrap();
        let text = dir.join("notes.txt");
        std::fs::write(&text, b"hi").unwrap();
        assert!(openable(&model).is_ok());
        assert_eq!(openable(&text).unwrap_err().code, "invalid_input");
        assert_eq!(openable(&dir.join("missing.stl")).unwrap_err().code, "not_found");
        assert_eq!(openable(Path::new("cube.stl")).unwrap_err().code, "invalid_input");
        assert_eq!(openable(&dir).unwrap_err().code, "not_found");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn export_names_stay_inside_the_export_folder() {
        assert_eq!(export_name("Cube_plate-1.gcode"), "Cube_plate-1.gcode");
        assert_eq!(export_name("part.bgcode"), "part.bgcode");
        assert_eq!(export_name("../../etc/passwd"), "passwd.gcode");
        assert_eq!(export_name("C:\\Windows\\evil.gcode"), "evil.gcode");
        assert_eq!(export_name("..gcode"), "gcode.gcode");
        assert_eq!(export_name(""), "plate.gcode");
        assert_eq!(export_name("a/b/"), "plate.gcode");
        assert_eq!(export_name("tower: 200C.gcode"), "tower 200C.gcode");
    }
}
