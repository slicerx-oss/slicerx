// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The printer bridge inside the desktop app. `link_start` runs the same sx-link server the standalone
//! program runs, on this computer's loopback address only, and hands the webview its address and pairing
//! code. The webview then connects to it like the browser build does, so approvals, printer setup and
//! camera streams take one path everywhere. The bridge stops when the app quits.
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
pub struct LinkInfo {
    url: String,
    code: String,
    /// The hub's public key; the webview checks the hub's `hello` against it before pairing.
    #[serde(rename = "hubKey")]
    hub_key: String,
}

/// Without the connect feature there is no bridge to start.
#[cfg(not(feature = "connect"))]
#[derive(Default)]
pub struct Bridge;

#[cfg(not(feature = "connect"))]
#[tauri::command]
pub async fn link_start(_state: State<'_, Bridge>) -> Result<LinkInfo, String> {
    Err("This build has no printer bridge.".to_owned())
}

#[cfg(feature = "connect")]
#[derive(Default)]
pub struct Bridge(tokio::sync::Mutex<Option<sx_link::Link>>);

#[cfg(feature = "connect")]
impl Bridge {
    /// The running hub, for commands in this process that act on it directly (agent credentials).
    pub(crate) async fn link(&self) -> tokio::sync::MutexGuard<'_, Option<sx_link::Link>> {
        self.0.lock().await
    }
}

/// Starts the bridge if it is not running and returns where it listens and its pairing code.
#[cfg(feature = "connect")]
#[tauri::command]
pub async fn link_start(app: tauri::AppHandle, state: State<'_, Bridge>) -> Result<LinkInfo, String> {
    use std::sync::Arc;

    use sx_connect::KeychainSecrets;
    use tauri::Manager;

    let mut slot = state.0.lock().await;
    if let Some(link) = slot.as_ref() {
        crate::watch::start(&app, &format!("ws://{}", link.addr()));
        return Ok(info(link));
    }
    let data = app.path().app_data_dir().ok();
    // Printer codes go to the keychain; on Windows, one it refuses is sealed with DPAPI in the app's data
    // folder instead of lasting only until the app closes (vault.rs).
    let keychain: Arc<dyn sx_connect::SecretStore> = Arc::new(KeychainSecrets::new("slicerx-printers"));
    let secrets: Arc<dyn sx_connect::SecretStore> = match &data {
        Some(d) => Arc::new(crate::vault::KeychainOrFile::new(keychain, d.join("vault"))),
        None => keychain,
    };
    // The printers, fleets and settings added through the bridge live in the app's own data folder, so
    // they are there at the next start. A standalone sx-link keeps its own (%APPDATA%\SlicerX\hub).
    let state = data.map(|d| d.join("hub"));
    let link = start_bridge(hub_port(), secrets, state).await?;
    let out = info(&link);
    crate::watch::start(&app, &out.url);
    *slot = Some(link);
    Ok(out)
}

/// The hub's port: sx-link's DEFAULT_PORT. A bridge test build takes another from `SX_TEST_HUB_PORT`, so the release
/// gate and the end-to-end tests can run next to each other, or next to an sx-link, on one machine.
#[cfg(feature = "connect")]
fn hub_port() -> u16 {
    #[cfg(feature = "agent-bridge")]
    return test_hub_port(std::env::var("SX_TEST_HUB_PORT").ok().as_deref());
    #[cfg(not(feature = "agent-bridge"))]
    sx_link::DEFAULT_PORT
}

/// `SX_TEST_HUB_PORT` as a port of 1024 or above; anything else is sx-link's DEFAULT_PORT. Compiled into bridge builds
/// only; a release binary never reads the variable (apps/desktop/release/check-agent-bridge.mjs looks for its name).
#[cfg(all(feature = "connect", feature = "agent-bridge"))]
pub(crate) fn test_hub_port(value: Option<&str>) -> u16 {
    value
        .and_then(|v| v.trim().parse::<u16>().ok())
        .filter(|p| *p >= 1024)
        .unwrap_or(sx_link::DEFAULT_PORT)
}

/// Starts the hub on `port` and nowhere else. Clients connect to 47615 with no way to tell a
/// squatter from this hub, so falling back to another port would let whatever holds 47615 collect
/// pairing codes. A taken port is an error the app shows.
#[cfg(feature = "connect")]
pub(crate) async fn start_bridge(
    port: u16,
    secrets: std::sync::Arc<dyn sx_connect::SecretStore>,
    state_dir: Option<std::path::PathBuf>,
) -> Result<sx_link::Link, String> {
    use std::sync::Arc;

    use sx_link::{BrokerGate, LinkConfig, serve_with_approvals};
    use sx_permit::ApprovalBroker;

    let broker =
        Arc::new(ApprovalBroker::new().map_err(|e| format!("The approval service did not start: {e}"))?);
    // the hub's messages name this edition, not SlicerX
    sx_link::set_app_name(&crate::brand::get().name);
    // Without a state folder the hub keeps everything in memory and forgets every printer at quit.
    let cfg = LinkConfig {
        port,
        state_dir,
        ..LinkConfig::default()
    };
    // A bridge test build only: the release gate shortens the watch pause's steps (docs/release-gate.md, w).
    #[cfg(feature = "agent-bridge")]
    let cfg = gate_watch_pause(cfg, std::env::var("SX_GATE_WATCH_PAUSE").ok().as_deref());
    match serve_with_approvals(cfg, Arc::new(BrokerGate(broker.clone())), secrets, Some(broker)).await {
        Ok(link) => Ok(link),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => Err(format!(
            "Port {port} is in use by another program, so the printer bridge did not start. If sx-link is already running, {} can use it; otherwise close the program holding the port.",
            crate::brand::get().name
        )),
        Err(e) => Err(format!("The printer bridge did not start: {e}")),
    }
}

/// The release gate's watch pause timings for a bridge test build: `SX_GATE_WATCH_PAUSE` as
/// `<watch every ms>,<bed off after ms>,<heaters off after ms>`, so scenario w sees the bed and nozzle
/// steps in seconds instead of 30 minutes and 2 hours. Anything else leaves the hub's own timings.
/// Compiled into bridge builds only; a release binary never reads the variable
/// (apps/desktop/release/check-agent-bridge.mjs looks for its name).
#[cfg(all(feature = "connect", feature = "agent-bridge"))]
pub(crate) fn gate_watch_pause(mut cfg: sx_link::LinkConfig, value: Option<&str>) -> sx_link::LinkConfig {
    use std::time::Duration;
    let ms: Vec<u64> = value
        .unwrap_or("")
        .split(',')
        .filter_map(|v| v.trim().parse().ok())
        .collect();
    if let [every, bed, heaters] = ms[..]
        && every >= 100
        && bed < heaters
    {
        cfg.watch_every = Duration::from_millis(every);
        cfg.pause_bed_off_after = Duration::from_millis(bed);
        cfg.pause_heaters_off_after = Duration::from_millis(heaters);
    }
    cfg
}

#[cfg(feature = "connect")]
fn info(link: &sx_link::Link) -> LinkInfo {
    LinkInfo {
        url: format!("ws://{}", link.addr()),
        code: link.pairing_code().to_string(),
        hub_key: link.hub_key().to_owned(),
    }
}

#[cfg(all(test, feature = "connect", feature = "agent-bridge"))]
mod gate_tests {
    use std::time::Duration;

    use super::{gate_watch_pause, test_hub_port};

    #[test]
    fn a_test_build_takes_its_hub_port_from_the_environment_and_nothing_else_moves_it() {
        assert_eq!(test_hub_port(Some("47715")), 47715);
        assert_eq!(test_hub_port(Some(" 50000 ")), 50000);
        for bad in [None, Some(""), Some("0"), Some("80"), Some("70000"), Some("port")] {
            assert_eq!(test_hub_port(bad), sx_link::DEFAULT_PORT, "{bad:?}");
        }
    }

    #[test]
    fn the_gate_shortens_the_watch_pause_steps_and_nothing_else_changes_them() {
        let cfg = gate_watch_pause(sx_link::LinkConfig::default(), Some("2000,12000,20000"));
        assert_eq!(cfg.watch_every, Duration::from_secs(2));
        assert_eq!(cfg.pause_bed_off_after, Duration::from_secs(12));
        assert_eq!(cfg.pause_heaters_off_after, Duration::from_secs(20));
        let own = sx_link::LinkConfig::default();
        for bad in [
            None,
            Some(""),
            Some("2000,12000"),
            Some("50,12000,20000"),
            Some("2000,20000,12000"),
            Some("a,b,c"),
        ] {
            let cfg = gate_watch_pause(sx_link::LinkConfig::default(), bad);
            assert_eq!(
                (
                    cfg.watch_every,
                    cfg.pause_bed_off_after,
                    cfg.pause_heaters_off_after
                ),
                (
                    own.watch_every,
                    own.pause_bed_off_after,
                    own.pause_heaters_off_after
                ),
                "{bad:?}"
            );
        }
    }
}

#[cfg(all(test, feature = "connect"))]
mod tests {
    use std::sync::Arc;

    use super::start_bridge;

    #[tokio::test]
    async fn a_taken_port_is_an_error_not_a_quiet_move_to_another_port() {
        // Between releasing the port and binding it again, another test running in parallel can be handed the same
        // port by the OS. That is the race, not the bridge, so it retries with a fresh port; a bridge that moved to
        // another port still fails here.
        for attempt in 0..20 {
            let squatter = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = squatter.local_addr().unwrap().port();
            let err = start_bridge(port, Arc::new(sx_connect::MemorySecrets::new()), None)
                .await
                .err()
                .unwrap();
            assert!(err.contains("in use"), "{err}");
            drop(squatter);
            match start_bridge(port, Arc::new(sx_connect::MemorySecrets::new()), None).await {
                Ok(link) => {
                    assert_eq!(link.addr().port(), port);
                    return;
                }
                Err(e) if e.contains("in use") && attempt < 19 => continue,
                Err(e) => panic!("{e}"),
            }
        }
    }

    /// The page connects to the URL `link_start` returns, so the webview's CSP must allow it. Without
    /// this the release app starts its bridge and then refuses to talk to it.
    #[tokio::test]
    async fn the_webview_csp_lets_the_page_reach_the_bridge() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let connect_src = conf["app"]["security"]["csp"]["connect-src"].as_str().unwrap();
        let allowed: Vec<&str> = connect_src.split_whitespace().collect();
        // The bridge listens on loopback only, at the port link_start asks for.
        let link = start_bridge(0, Arc::new(sx_connect::MemorySecrets::new()), None)
            .await
            .unwrap();
        assert_eq!(link.addr().ip().to_string(), "127.0.0.1");
        let url = format!("ws://127.0.0.1:{}", sx_link::DEFAULT_PORT);
        assert!(
            allowed.contains(&url.as_str()),
            "connect-src \"{connect_src}\" does not allow the bridge at {url}"
        );
    }

    /// A printer added through the bridge must be there after the app restarts: the bridge keeps its
    /// state in the folder it is given, and a new bridge on that folder reads it back.
    #[tokio::test]
    async fn the_bridge_keeps_its_state_in_the_folder_it_is_given() {
        let dir = std::env::temp_dir().join(format!("sx-desktop-hub-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let link = start_bridge(0, Arc::new(sx_connect::MemorySecrets::new()), Some(dir.clone()))
            .await
            .unwrap();
        assert_eq!(link.state_dir(), Some(dir.as_path()));
        drop(link);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
