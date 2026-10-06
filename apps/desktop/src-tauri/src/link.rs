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
    use sx_link::DEFAULT_PORT;
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
    let link = start_bridge(DEFAULT_PORT, secrets, state).await?;
    let out = info(&link);
    crate::watch::start(&app, &out.url);
    *slot = Some(link);
    Ok(out)
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
    // Without a state folder the hub keeps everything in memory and forgets every printer at quit.
    let cfg = LinkConfig {
        port,
        state_dir,
        ..LinkConfig::default()
    };
    match serve_with_approvals(cfg, Arc::new(BrokerGate(broker.clone())), secrets, Some(broker)).await {
        Ok(link) => Ok(link),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => Err(format!(
            "Port {port} is in use by another program, so the printer bridge did not start. If sx-link is already running, {} can use it; otherwise close the program holding the port.",
            crate::brand::get().name
        )),
        Err(e) => Err(format!("The printer bridge did not start: {e}")),
    }
}

#[cfg(feature = "connect")]
fn info(link: &sx_link::Link) -> LinkInfo {
    LinkInfo {
        url: format!("ws://{}", link.addr()),
        code: link.pairing_code().to_string(),
        hub_key: link.hub_key().to_owned(),
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
