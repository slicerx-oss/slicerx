// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! "Connect your AI agent": where the bundled MCP server is, an agent's credential in the keychain
//! (service `slicerx-agent-<client>`, account `slicerx`, as the server reads it), running a client's
//! install command, and opening a client's install link. Nothing here returns a secret.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Where the MCP server runs from, first match wins: the standalone build in the app bundle
/// (`Resources/mcp/slicerx-mcp.mjs`, every dependency inlined, runs with plain `node`), the older
/// `mcp/dist/cli.js` layout, then a development checkout.
fn server_in(resources: Option<PathBuf>, checkout: Option<PathBuf>) -> Option<PathBuf> {
    let bundled = resources.iter().flat_map(|d| {
        [
            d.join("mcp").join("slicerx-mcp.mjs"),
            d.join("mcp").join("dist").join("cli.js"),
        ]
    });
    let dev = checkout.map(|d| d.join("../../../packages/mcp/dist/cli.js"));
    bundled.chain(dev).find(|p| p.is_file())
}

#[tauri::command]
pub fn mcp_server_path(app: AppHandle) -> Option<String> {
    let checkout: Option<PathBuf> = option_env!("CARGO_MANIFEST_DIR").map(PathBuf::from);
    server_in(app.path().resource_dir().ok(), checkout)
        .and_then(|p| p.canonicalize().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Packs Claude Desktop's extension: the manifest the webview built plus the bundled server under `server/`,
/// as one .mcpb (a zip) in the app's cache folder. Returns its path. The manifest names `server/cli.js`; the
/// bundled server's entry is `slicerx-mcp.mjs`, so those two names are swapped here.
fn pack_mcpb(
    manifest: &serde_json::Value,
    server_dir: &std::path::Path,
    out: &std::path::Path,
) -> Result<(), String> {
    use std::io::Write;
    let text = serde_json::to_string_pretty(manifest)
        .map_err(|e| e.to_string())?
        .replace("server/cli.js", "server/slicerx-mcp.mjs");
    let file = std::fs::File::create(out).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("manifest.json", opts).map_err(|e| e.to_string())?;
    zip.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    fn walk(
        zip: &mut zip::ZipWriter<std::fs::File>,
        opts: zip::write::SimpleFileOptions,
        dir: &std::path::Path,
        prefix: &str,
    ) -> Result<(), String> {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .collect();
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for e in entries {
            let name = format!("{prefix}/{}", e.file_name().to_string_lossy());
            let path = e.path();
            if path.is_dir() {
                walk(zip, opts, &path, &name)?;
            } else {
                zip.start_file(&name, opts).map_err(|e| e.to_string())?;
                std::io::copy(&mut std::fs::File::open(&path).map_err(|e| e.to_string())?, zip)
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
    walk(&mut zip, opts, server_dir, "server")?;
    zip.finish().map(|_| ()).map_err(|e| e.to_string())
}

/// The hub's public key as `link_start` hands it out: standard base64 of 32 bytes (44 characters).
fn valid_hub_key(key: &str) -> bool {
    key.len() == 44
        && key.ends_with('=')
        && key[..43]
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
}

/// The hub's address on this computer: `ws://127.0.0.1:<port>` and nothing else.
fn valid_link_url(url: &str) -> bool {
    url.strip_prefix("ws://127.0.0.1:")
        .is_some_and(|port| port.parse::<u16>().is_ok_and(|p| p > 0) && !port.starts_with('0'))
}

/// The environment the server starts with for `client` (`serverEnv` in packages/mcp). Holds no secret.
fn server_env(client: &str, hub_key: &str, link_url: &str) -> Result<serde_json::Value, String> {
    client_ok(client)?;
    if !valid_hub_key(hub_key) {
        return Err("bad hub key".to_owned());
    }
    if !valid_link_url(link_url) {
        return Err("the hub address must be ws://127.0.0.1:<port>".to_owned());
    }
    Ok(serde_json::json!({
        "SLICERX_MCP_PRINTERS": "link",
        "SLICERX_MCP_LINK_URL": link_url,
        "SLICERX_MCP_LINK_HUB_KEY": hub_key,
        "SLICERX_MCP_LINK_KEY_REF": format!("slicerx-agent-{client}"),
    }))
}

/// The one install command each command-line client has, built here from checked values. The
/// webview names the client and passes the hub's key and address; it never passes arguments, so
/// it cannot add flags such as `--dangerously-skip-permissions` or run a prompt.
fn install_argv(
    client: &str,
    server: &std::path::Path,
    hub_key: &str,
    link_url: &str,
) -> Result<Vec<String>, String> {
    install_argv_for(
        &crate::brand::get().server_id(),
        client,
        server,
        hub_key,
        link_url,
    )
}

/// `install_argv` for the server name `id` (the edition's, `Brand::server_id`).
fn install_argv_for(
    id: &str,
    client: &str,
    server: &std::path::Path,
    hub_key: &str,
    link_url: &str,
) -> Result<Vec<String>, String> {
    let env = server_env(client, hub_key, link_url)?;
    let server = server.to_str().ok_or("the server path is not text")?.to_owned();
    match client {
        "claude-code" => {
            let stdio =
                serde_json::json!({ "type": "stdio", "command": "node", "args": [server], "env": env });
            Ok(vec![
                "claude".into(),
                "mcp".into(),
                "add-json".into(),
                id.into(),
                stdio.to_string(),
                "--scope".into(),
                "user".into(),
            ])
        }
        "codex" => {
            let mut argv: Vec<String> = vec!["codex".into(), "mcp".into(), "add".into(), id.into()];
            for (k, v) in env.as_object().into_iter().flatten() {
                argv.push("--env".into());
                argv.push(format!("{k}={}", v.as_str().unwrap_or_default()));
            }
            argv.extend(["--".into(), "node".into(), server]);
            Ok(argv)
        }
        _ => Err(format!("{client} does not install with a command")),
    }
}

/// Claude Desktop's extension manifest (`installSteps` in packages/mcp), built here so the webview
/// cannot change what Claude Desktop is asked to run.
fn bundle_manifest(
    brand: &crate::brand::Brand,
    hub_key: &str,
    link_url: &str,
) -> Result<serde_json::Value, String> {
    let env = server_env("claude-desktop", hub_key, link_url)?;
    let mut author = serde_json::json!({ "name": brand.publisher });
    if let Some(url) = &brand.homepage {
        author["url"] = url.clone().into();
    }
    Ok(serde_json::json!({
        "manifest_version": "0.3",
        "name": brand.server_id(),
        "display_name": brand.name,
        "version": "0.1.0",
        "description": format!("Slice, plan settings, and read and control your printers through the {} hub on this computer.", brand.name),
        "author": author,
        "license": "Apache-2.0",
        "server": {
            "type": "node",
            "entry_point": "server/cli.js",
            "mcp_config": { "command": "node", "args": ["${__dirname}/server/cli.js"], "env": env },
        },
    }))
}

/// Builds the .mcpb for Claude Desktop and opens it with the system, which hands it to Claude
/// Desktop. The manifest is built here from the hub's key and address.
#[tauri::command]
pub async fn agent_bundle(app: AppHandle, hub_key: String, link_url: String) -> Result<String, String> {
    let brand = crate::brand::get();
    let file_name = format!("{}.mcpb", brand.server_id());
    let manifest = bundle_manifest(brand, &hub_key, &link_url)?;
    let checkout: Option<PathBuf> = option_env!("CARGO_MANIFEST_DIR").map(PathBuf::from);
    let server = server_in(app.path().resource_dir().ok(), checkout)
        .ok_or("The bundled MCP server is not in this build.")?;
    let server_dir = server.parent().ok_or("bad server path")?.to_path_buf();
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(file_name);
    let packed = out.clone();
    tauri::async_runtime::spawn_blocking(move || pack_mcpb(&manifest, &server_dir, &packed))
        .await
        .map_err(|e| e.to_string())??;
    // Opened by the system's handler for .mcpb files, never through `cmd /C start` (launch.rs).
    crate::launch::open_path(&out)?;
    Ok(out.to_string_lossy().into_owned())
}

fn client_ok(client: &str) -> Result<(), String> {
    match client {
        "claude-desktop" | "claude-code" | "cursor" | "codex" | "chatgpt" => Ok(()),
        _ => Err("unknown agent".to_owned()),
    }
}

fn store_key(client: &str, key: &str) -> Result<(), String> {
    if key.trim().is_empty() || key.len() > 512 {
        return Err("bad credential".to_owned());
    }
    let entry =
        keyring::Entry::new(&format!("slicerx-agent-{client}"), "slicerx").map_err(|e| e.to_string())?;
    entry.set_password(key.trim()).map_err(|e| e.to_string())
}

/// Keeps an agent's hub credential in the keychain. The webview hands it over once and never reads it back.
#[tauri::command]
pub fn agent_key_store(client: String, key: String) -> Result<(), String> {
    client_ok(&client)?;
    store_key(&client, &key)
}

/// The name the hub lists this agent under (Settings > Devices), one per client on this computer.
fn agent_name(client: &str) -> &'static str {
    match client {
        "claude-desktop" => "Claude Desktop (this computer)",
        "claude-code" => "Claude Code (this computer)",
        "cursor" => "Cursor (this computer)",
        "codex" => "Codex (this computer)",
        _ => "ChatGPT (this computer)",
    }
}

/// What the webview learns about an agent's credential: the hub's id for it, never the key.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCredential {
    client_id: String,
}

/// Gets this agent its own hub credential (`clients.create`, role agent) and puts it in the keychain
/// under `slicerx-agent-<client>`. The key goes from the hub to the keychain inside this process:
/// it is never returned, logged or shown. An earlier credential for the same agent is revoked.
#[cfg(feature = "connect")]
#[tauri::command]
pub async fn agent_credential(
    client: String,
    state: tauri::State<'_, crate::link::Bridge>,
) -> Result<AgentCredential, String> {
    client_ok(&client)?;
    let slot = state.link().await;
    let link = slot.as_ref().ok_or_else(|| {
        "The printer bridge is not running, so there is no hub to ask for a credential.".to_owned()
    })?;
    let keep = client.clone();
    let client_id = hub::agent_key(link, agent_name(&client), move |key| store_key(&keep, key)).await?;
    Ok(AgentCredential { client_id })
}

#[cfg(not(feature = "connect"))]
#[tauri::command]
pub async fn agent_credential(client: String) -> Result<AgentCredential, String> {
    client_ok(&client)?;
    Err("This build has no printer bridge, so there is no hub to ask for a credential.".to_owned())
}

/// Revokes this agent's hub credential and removes it from the keychain.
#[cfg(feature = "connect")]
#[tauri::command]
pub async fn agent_disconnect(
    client: String,
    state: tauri::State<'_, crate::link::Bridge>,
) -> Result<(), String> {
    client_ok(&client)?;
    if let Some(link) = state.link().await.as_ref() {
        hub::revoke_named(link, agent_name(&client)).await?;
    }
    agent_key_clear(client)
}

#[cfg(not(feature = "connect"))]
#[tauri::command]
pub async fn agent_disconnect(client: String) -> Result<(), String> {
    agent_key_clear(client)
}

/// True when the keychain holds a credential for this agent. Says nothing about the key itself.
#[tauri::command]
pub fn agent_connected(client: String) -> Result<bool, String> {
    client_ok(&client)?;
    match keyring::Entry::new(&format!("slicerx-agent-{client}"), "slicerx").and_then(|e| e.get_password()) {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// Agent credentials from the hub this app runs, made in process through the `Link` it holds. Nothing
/// goes over a socket, so the app code is never sent anywhere and a program squatting on the hub's
/// port cannot receive it or hand back a key of its own.
#[cfg(feature = "connect")]
mod hub {
    /// Makes an agent credential named `name`, hands the key to `keep` and returns the client id.
    /// Credentials made earlier under the same name are revoked first; when `keep` fails, so is the new one.
    pub(super) async fn agent_key(
        link: &sx_link::Link,
        name: &str,
        keep: impl FnOnce(&str) -> Result<(), String>,
    ) -> Result<String, String> {
        let made = link.create_agent_key(name).await?;
        if let Err(e) = keep(&made.key) {
            let _ = link.revoke_client(&made.client_id).await;
            return Err(format!("The keychain did not take the credential: {e}"));
        }
        Ok(made.client_id)
    }

    pub(super) async fn revoke_named(link: &sx_link::Link, name: &str) -> Result<(), String> {
        link.revoke_agents_named(name).await.map(|_| ())
    }

    #[cfg(test)]
    mod tests {
        use std::sync::{Arc, Mutex};

        use futures::{SinkExt, StreamExt};
        use serde_json::{Value, json};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio_tungstenite::{connect_async, tungstenite::Message};

        use super::*;

        async fn bridge() -> sx_link::Link {
            let port = std::net::TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port();
            crate::link::start_bridge(port, Arc::new(sx_connect::MemorySecrets::new()), None)
                .await
                .unwrap()
        }

        async fn pair_with_key(port: u16, key: &str) -> Value {
            let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}/")).await.unwrap();
            ws.send(Message::text(
                json!({ "id": 1, "method": "pair", "params": { "clientKey": key } }).to_string(),
            ))
            .await
            .unwrap();
            loop {
                if let Some(Ok(Message::Text(t))) = ws.next().await {
                    break serde_json::from_str(t.as_str()).unwrap();
                }
            }
        }

        #[tokio::test]
        async fn the_agent_key_goes_to_the_keeper_and_pairs_as_an_agent() {
            let link = bridge().await;
            let kept = Arc::new(Mutex::new(String::new()));
            let k = kept.clone();
            let id = agent_key(&link, "Codex (this computer)", move |key| {
                *k.lock().unwrap() = key.to_owned();
                Ok(())
            })
            .await
            .unwrap();
            let key = kept.lock().unwrap().clone();
            assert!(id.starts_with("client-"), "{id}");
            assert!(!id.contains(&key));
            let reply = pair_with_key(link.addr().port(), &key).await;
            assert_eq!(reply["result"]["role"], "agent", "{reply}");
        }

        #[tokio::test]
        async fn a_second_install_revokes_the_first_and_a_failed_keychain_write_leaves_nothing() {
            let link = bridge().await;
            let first = agent_key(&link, "Cursor (this computer)", |_| Ok(()))
                .await
                .unwrap();
            let second = agent_key(&link, "Cursor (this computer)", |_| Ok(()))
                .await
                .unwrap();
            assert_ne!(first, second);
            assert_eq!(
                link.agent_ids_named("Cursor (this computer)"),
                vec![second.clone()]
            );

            let err = agent_key(&link, "Codex (this computer)", |_| Err("locked".to_owned()))
                .await
                .unwrap_err();
            assert!(err.contains("keychain"), "{err}");
            assert!(link.agent_ids_named("Codex (this computer)").is_empty());

            revoke_named(&link, "Cursor (this computer)").await.unwrap();
            assert!(link.agent_ids_named("Cursor (this computer)").is_empty());
        }

        // R2: the shell used to pair over the hub's port with the app code in clear. With the hub
        // gone and a program holding its port, making and revoking a key must send that program
        // nothing at all.
        #[tokio::test]
        async fn r2_a_squatter_on_the_hub_port_hears_nothing() {
            let link = bridge().await;
            let port = link.addr().port();
            let heard = Arc::new(Mutex::new(Vec::<u8>::new()));
            let h = heard.clone();
            // The squatter takes the port the moment the hub's listener lets it go. The Link value
            // stays alive for the in-process calls; only its listener is replaced.
            link.stop_listening();
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let squatter = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
            let listen = tokio::spawn(async move {
                while let Ok((mut s, _)) = squatter.accept().await {
                    let mut buf = vec![0_u8; 4096];
                    if let Ok(n) = s.read(&mut buf).await {
                        h.lock().unwrap().extend_from_slice(&buf[..n]);
                    }
                    let _ = s.shutdown().await;
                }
            });
            let id = agent_key(&link, "Cursor (this computer)", |_| Ok(()))
                .await
                .unwrap();
            revoke_named(&link, "Cursor (this computer)").await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            listen.abort();
            assert!(id.starts_with("client-"));
            assert!(
                heard.lock().unwrap().is_empty(),
                "the shell reached out over the hub's port"
            );
        }
    }
}

#[tauri::command]
pub fn agent_key_clear(client: String) -> Result<(), String> {
    client_ok(&client)?;
    match keyring::Entry::new(&format!("slicerx-agent-{client}"), "slicerx")
        .and_then(|e| e.delete_credential())
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Runs a client's own install command (`claude mcp add-json slicerx ...`, `codex mcp add slicerx ...`),
/// built in `install_argv` from the client name, the bundled server's path and the hub's checked key
/// and address. Never a shell, never arguments from the webview.
#[tauri::command]
pub async fn agent_run(
    app: AppHandle,
    client: String,
    hub_key: String,
    link_url: String,
) -> Result<String, String> {
    let checkout: Option<PathBuf> = option_env!("CARGO_MANIFEST_DIR").map(PathBuf::from);
    let server = server_in(app.path().resource_dir().ok(), checkout)
        .and_then(|p| p.canonicalize().ok())
        .ok_or("The bundled MCP server is not in this build.")?;
    let argv = install_argv(&client, &server, &hub_key, &link_url)?;
    let Some((program, args)) = argv.split_first() else {
        return Err("nothing to run".to_owned());
    };
    let (program, args) = (program.clone(), args.to_vec());
    tauri::async_runtime::spawn_blocking(move || {
        let out = crate::launch::no_window(std::process::Command::new(&program).args(&args))
            .output()
            .map_err(|e| format!("{program} did not start: {e}. Is it installed and on your PATH?"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(format!(
                "{program} said: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens a client's install link. Only the schemes the clients register.
#[tauri::command]
pub fn open_deeplink(url: String) -> Result<(), String> {
    if !url.starts_with("cursor://") {
        return Err("only client install links open here".to_owned());
    }
    // Never `cmd /C start`, which ran a second command from an `&` in the link (launch.rs).
    crate::launch::open_url(&url)
}

#[cfg(test)]
mod bundle_tests {
    use super::*;

    const KEY: &str = "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=";

    #[test]
    fn m7_install_commands_are_fixed_templates_and_refuse_anything_else() {
        let server = std::path::Path::new("/Applications/SlicerX.app/Contents/Resources/mcp/slicerx-mcp.mjs");
        let cc = install_argv("claude-code", server, KEY, "ws://127.0.0.1:47615").unwrap();
        assert_eq!(cc[..4], ["claude", "mcp", "add-json", "slicerx"]);
        assert_eq!(cc[5..], ["--scope", "user"]);
        let json: serde_json::Value = serde_json::from_str(&cc[4]).unwrap();
        assert_eq!(json["args"][0], server.to_str().unwrap());
        assert_eq!(
            json["env"]["SLICERX_MCP_LINK_KEY_REF"],
            "slicerx-agent-claude-code"
        );
        let cx = install_argv("codex", server, KEY, "ws://127.0.0.1:47615").unwrap();
        assert_eq!(cx[..4], ["codex", "mcp", "add", "slicerx"]);
        assert_eq!(cx[cx.len() - 3..], ["--", "node", server.to_str().unwrap()]);
        assert!(cx.iter().all(|a| !a.contains("dangerously")));
        // Values that would smuggle in a flag, a prompt or another host are refused.
        for (key, url) in [
            ("--dangerously-skip-permissions", "ws://127.0.0.1:47615"),
            (
                KEY,
                "ws://127.0.0.1:47615 --dangerously-bypass-approvals-and-sandbox",
            ),
            (KEY, "ws://evil.example:47615"),
            (KEY, "ws://127.0.0.1:0"),
            (
                "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83v -p hi=",
                "ws://127.0.0.1:47615",
            ),
        ] {
            assert!(
                install_argv("claude-code", server, key, url).is_err(),
                "{key} {url}"
            );
        }
        assert!(install_argv("cursor", server, KEY, "ws://127.0.0.1:47615").is_err());
        assert!(install_argv("sh", server, KEY, "ws://127.0.0.1:47615").is_err());
        let m = bundle_manifest(crate::brand::get(), KEY, "ws://127.0.0.1:47615").unwrap();
        assert_eq!(m["server"]["mcp_config"]["env"]["SLICERX_MCP_LINK_HUB_KEY"], KEY);
        assert_eq!(m["name"], "slicerx");
        assert!(bundle_manifest(crate::brand::get(), "nope", "ws://127.0.0.1:47615").is_err());
    }

    #[test]
    fn a_white_label_build_registers_its_own_server() {
        let acme = crate::brand::tests::acme();
        let server =
            std::path::Path::new("/Applications/Acme Slicer.app/Contents/Resources/mcp/slicerx-mcp.mjs");
        let cc = install_argv_for(
            &acme.server_id(),
            "claude-code",
            server,
            KEY,
            "ws://127.0.0.1:47615",
        )
        .unwrap();
        assert_eq!(cc[..4], ["claude", "mcp", "add-json", "acmeslicer"]);
        let cx = install_argv_for(&acme.server_id(), "codex", server, KEY, "ws://127.0.0.1:47615").unwrap();
        assert_eq!(cx[3], "acmeslicer");
        let m = bundle_manifest(&acme, KEY, "ws://127.0.0.1:47615").unwrap();
        assert_eq!(m["name"], "acmeslicer");
        assert_eq!(m["display_name"], "Acme Slicer");
        assert_eq!(m["author"]["name"], "Acme Printers Inc.");
        assert!(!m["description"].as_str().unwrap().contains("SlicerX"));
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sx-mcpb-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_standalone_server_is_found_before_the_old_layout() {
        let res = tmp("res");
        std::fs::create_dir_all(res.join("mcp").join("dist")).unwrap();
        std::fs::write(res.join("mcp").join("dist").join("cli.js"), "old").unwrap();
        assert_eq!(
            server_in(Some(res.clone()), None),
            Some(res.join("mcp").join("dist").join("cli.js"))
        );
        std::fs::write(res.join("mcp").join("slicerx-mcp.mjs"), "new").unwrap();
        assert_eq!(
            server_in(Some(res.clone()), None),
            Some(res.join("mcp").join("slicerx-mcp.mjs"))
        );
        assert_eq!(server_in(None, None), None);
    }

    #[test]
    fn the_extension_holds_the_manifest_and_the_server_tree() {
        let server = tmp("server");
        std::fs::create_dir_all(server.join("chunks")).unwrap();
        std::fs::write(server.join("slicerx-mcp.mjs"), "x").unwrap();
        std::fs::write(server.join("chunks").join("a.mjs"), "y").unwrap();
        let out = tmp("out").join("slicerx.mcpb");
        pack_mcpb(
            &serde_json::json!({ "server": { "entry_point": "server/cli.js" } }),
            &server,
            &out,
        )
        .unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_owned())
            .collect();
        assert!(names.contains(&"manifest.json".to_owned()));
        assert!(names.contains(&"server/slicerx-mcp.mjs".to_owned()));
        assert!(names.contains(&"server/chunks/a.mjs".to_owned()));
        let mut text = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("manifest.json").unwrap(), &mut text).unwrap();
        assert!(text.contains("server/slicerx-mcp.mjs") && !text.contains("cli.js"));
    }
}
