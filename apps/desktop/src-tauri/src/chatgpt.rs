// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Sign in with ChatGPT for the assistant (sx-llm chatgpt): the browser sign-in, the
//! connected account, disconnect, and the pasted API key fallback. Tokens and keys live in
//! the system keychain; the webview only ever sees the public `Account`.

use std::time::Duration;

use sx_llm::SystemKeySource;
use sx_llm::chatgpt::{self, Account, ConnectOptions, Endpoints};

/// Loopback port the sign-in page redirects to. sx-llm's default: the client OpenAI registers
/// at the first sign-in is bound to this redirect, so every sign-in from this app uses the same one.
const REDIRECT_PORT: u16 = chatgpt::DEFAULT_REDIRECT_PORT;
/// How long the person has to finish in the browser.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

fn endpoints() -> Result<Endpoints, String> {
    Endpoints::openai().map_err(|e| e.to_string())
}

/// Opens an https URL in the system browser. Only https: nothing else may reach the shell.
pub fn open_in_browser(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https links open in the browser".into());
    }
    let (program, args): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("open", vec![url])
    } else if cfg!(target_os = "windows") {
        ("cmd", vec!["/C", "start", "", url])
    } else {
        ("xdg-open", vec![url])
    };
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    open_in_browser(&url)
}

/// Signs in through the browser and keeps the connection in the keychain.
#[tauri::command]
pub async fn chatgpt_connect() -> Result<Account, String> {
    let open = |url: &str| {
        open_in_browser(url).map_err(|m| sx_llm::Error::Http {
            status: 0,
            message: m,
        })
    };
    let opts = ConnectOptions {
        endpoints: endpoints()?,
        redirect_port: REDIRECT_PORT,
        app_name: &crate::brand::get().name,
        open_url: &open,
        timeout: SIGN_IN_TIMEOUT,
    };
    chatgpt::connect(&SystemKeySource, &opts)
        .await
        .map_err(|e| e.to_string())
}

/// The connected account, if any. Never a token.
#[tauri::command]
pub fn chatgpt_account() -> Option<Account> {
    chatgpt::account(&SystemKeySource)
}

#[tauri::command]
pub async fn chatgpt_disconnect() -> Result<(), String> {
    chatgpt::disconnect(&SystemKeySource, &endpoints()?)
        .await
        .map_err(|e| e.to_string())
}

/// Keeps a pasted API key (`openai` or `anthropic`) in the keychain.
#[tauri::command]
pub fn chatgpt_set_api_key(provider: String, key: String) -> Result<(), String> {
    chatgpt::set_api_key(&SystemKeySource, &provider, &key).map_err(|e| e.to_string())
}

/// True when a pasted API key is saved for the provider.
#[tauri::command]
pub async fn chatgpt_has_api_key(provider: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        chatgpt::has_api_key(&SystemKeySource, &provider).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Moves a key that older builds kept in the printer hub's keychain item to the one the model reads.
pub fn migrate_api_keys() {
    std::thread::spawn(|| chatgpt::migrate_api_keys(&SystemKeySource));
}

#[tauri::command]
pub fn chatgpt_clear_api_key(provider: String) -> Result<(), String> {
    chatgpt::clear_api_key(&SystemKeySource, &provider).map_err(|e| e.to_string())
}
