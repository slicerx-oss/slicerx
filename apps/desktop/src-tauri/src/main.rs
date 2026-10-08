// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! slicerx-desktop: the Tauri v2 shell around `@slicerx/app`. Each command
//! maps to one method of the desktop `Host` (apps/desktop/src/host).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "agent-bridge")]
mod agent_bridge;
#[cfg(feature = "pilot")]
mod agents;
#[cfg(feature = "connect")]
mod bambu_connect;
mod brand;
#[cfg(feature = "pilot")]
mod chatgpt;
mod closing;
mod crash;
mod files;
#[cfg(feature = "connect")]
mod firewall;
mod gpu;
mod header;
mod launch;
mod link;
#[cfg(feature = "pilot")]
mod llm;
#[cfg(feature = "pilot")]
mod localai;
mod menu;
mod opened;
#[cfg(feature = "connect")]
mod pairdoc;
mod presets;
mod probe;
mod slicing;
mod themes;
mod updates;
#[cfg(feature = "connect")]
mod vault;
#[cfg(feature = "connect")]
mod watch;

fn main() {
    probe::mark_start();
    // First, so a panic anywhere after this leaves a report for the next launch.
    crash::install_hook();
    // The edition's name and link scheme, from the config this build was made with; the menu and links read it.
    let context = tauri::generate_context!();
    brand::init(context.config());
    let has_feed = updates::configured(context.config());
    let builder = tauri::Builder::default();
    // A web view whose content process died is reported and loaded again (macOS only reports this).
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(crash::webview_terminated);
    let builder = builder
        // First, so a second launch (a double-clicked file, an "Open in" link) reaches this one instead of opening another app.
        // Links go to the deep link plugin through the feature; files arrive as arguments.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            opened::handle(
                app,
                argv.into_iter()
                    .skip(1)
                    .filter(|a| !a.contains("://") || a.starts_with("file://"))
                    .collect(),
            );
            if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // The menu bar is there from the first frame; the page swaps in the live one when it loads.
        .menu(menu::initial)
        .on_menu_event(menu::on_event)
        .plugin(tauri_plugin_deep_link::init());
    // The updater runs only in a build whose edition has an update feed; without one the plugin has no config to start from.
    let builder = if has_feed {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    #[cfg(feature = "agent-bridge")]
    let builder = builder.manage(agent_bridge::Relay::default());
    let app = builder
        .manage(slicing::Slicer::default())
        .manage(files::OpenFiles::default())
        .manage(link::Bridge::default())
        .manage(opened::Pending::default())
        .manage(opened::PendingAuth::default())
        .manage(closing::Unsaved::default())
        .manage(menu::Shown::default())
        .manage(updates::Updates::new(has_feed))
        .on_window_event(closing::window_event)
        .manage(watch_state())
        .setup(|app| {
            crash::set_dir(app.handle());
            #[cfg(all(windows, not(debug_assertions)))]
            if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                crash::disable_browser_keys(&w);
            }
            gpu::warm();
            use tauri_plugin_deep_link::DeepLinkExt;
            let handle = app.handle().clone();
            // Links that opened the app, then links that arrive while it runs.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                opened::handle(&handle, urls.iter().map(ToString::to_string).collect());
            }
            let later = handle.clone();
            app.deep_link().on_open_url(move |event| {
                opened::handle(&later, event.urls().iter().map(ToString::to_string).collect())
            });
            // Windows and Linux pass a double-clicked file as an argument.
            opened::handle(&handle, std::env::args().skip(1).collect());
            #[cfg(feature = "pilot")]
            chatgpt::migrate_api_keys();
            // Dev and test builds only, and only with SX_AGENT_BRIDGE_PORT set.
            #[cfg(feature = "agent-bridge")]
            agent_bridge::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            slicing::load_mesh,
            slicing::slice,
            slicing::get_preview,
            slicing::get_gcode,
            slicing::release,
            files::open_files,
            files::read_file,
            files::save_file,
            files::save_file_to,
            link::link_start,
            closing::unsaved_set,
            closing::quit_app,
            menu::menu_key,
            menu::menu_sync,
            menu::menu_enable,
            gpu::gl_renderer,
            opened::opened_take,
            opened::auth_callback_take,
            presets::presets_scan,
            presets::presets_read,
            #[cfg(feature = "connect")]
            pairdoc::pair_doc_read,
            #[cfg(feature = "connect")]
            pairdoc::pair_doc_write,
            #[cfg(feature = "connect")]
            bambu_connect::bambu_connect_open,
            #[cfg(feature = "connect")]
            firewall::firewall_inbound,
            #[cfg(feature = "connect")]
            firewall::firewall_open_settings,
            updates::update_mode,
            updates::update_check,
            updates::update_download,
            updates::update_restart,
            themes::themes_list,
            themes::themes_open_folder,
            probe::probe_enabled,
            probe::probe_report,
            crash::crash_take,
            crash::crash_ack,
            crash::crash_test_panic,
            #[cfg(feature = "pilot")]
            chatgpt::open_external,
            #[cfg(feature = "pilot")]
            chatgpt::chatgpt_connect,
            #[cfg(feature = "pilot")]
            chatgpt::chatgpt_account,
            #[cfg(feature = "pilot")]
            chatgpt::chatgpt_disconnect,
            #[cfg(feature = "pilot")]
            chatgpt::chatgpt_set_api_key,
            #[cfg(feature = "pilot")]
            chatgpt::chatgpt_clear_api_key,
            #[cfg(feature = "pilot")]
            chatgpt::chatgpt_has_api_key,
            #[cfg(feature = "pilot")]
            llm::llm_available,
            #[cfg(feature = "pilot")]
            llm::llm_billing,
            #[cfg(feature = "pilot")]
            llm::llm_local_models,
            #[cfg(feature = "pilot")]
            llm::llm_stream,
            #[cfg(feature = "pilot")]
            llm::llm_cancel,
            #[cfg(feature = "pilot")]
            localai::local_ai_hardware,
            #[cfg(feature = "pilot")]
            localai::local_ai_get,
            #[cfg(feature = "pilot")]
            agents::mcp_server_path,
            #[cfg(feature = "pilot")]
            agents::agent_key_store,
            #[cfg(feature = "pilot")]
            agents::agent_key_clear,
            #[cfg(feature = "pilot")]
            agents::agent_credential,
            #[cfg(feature = "pilot")]
            agents::agent_disconnect,
            #[cfg(feature = "pilot")]
            agents::agent_connected,
            #[cfg(feature = "pilot")]
            agents::agent_run,
            #[cfg(feature = "pilot")]
            agents::agent_bundle,
            #[cfg(feature = "pilot")]
            agents::open_deeplink,
            #[cfg(feature = "agent-bridge")]
            agent_bridge::agent_bridge_ready,
            #[cfg(feature = "agent-bridge")]
            agent_bridge::agent_bridge_reply,
        ])
        .build(context)
        .expect("the Tauri runtime failed to start");
    app.run(|handle, event| match event {
        // macOS hands a double-clicked file to the running app as an event.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => opened::handle(
            handle,
            urls.iter()
                .filter(|u| u.scheme() == "file")
                .map(ToString::to_string)
                .collect(),
        ),
        tauri::RunEvent::Exit => {
            #[cfg(feature = "connect")]
            watch::stop(handle);
            #[cfg(feature = "agent-bridge")]
            agent_bridge::stop(handle);
            let _ = handle;
        }
        _ => {
            let _ = handle;
        }
    });
}

#[cfg(feature = "connect")]
fn watch_state() -> watch::Watch {
    watch::Watch::default()
}

#[cfg(not(feature = "connect"))]
fn watch_state() {}
