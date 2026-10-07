// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! API key lookup. Keys are read at request time and dropped after the request is built.
//! Nothing here writes, caches or logs a key.

/// Keychain service name of the OpenAI key (a generic password on macOS).
pub const OPENAI_KEYCHAIN_SERVICE: &str = "slicerx-openai-api-key";
/// Keychain account name of the OpenAI key.
pub const OPENAI_KEYCHAIN_ACCOUNT: &str = "slicerx";
/// Environment variables checked, in order, when the keychain has no OpenAI key.
pub const OPENAI_KEY_ENV: [&str; 2] = ["SLICERX_OPENAI_API_KEY", "OPENAI_API_KEY"];

/// Keychain service name of the Anthropic key.
pub const ANTHROPIC_KEYCHAIN_SERVICE: &str = "slicerx-anthropic-api-key";
/// Keychain account name of the Anthropic key.
pub const ANTHROPIC_KEYCHAIN_ACCOUNT: &str = "slicerx";
/// Environment variables checked, in order, when the keychain has no Anthropic key.
pub const ANTHROPIC_KEY_ENV: [&str; 2] = ["SLICERX_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"];

/// Keychain service name of the optional key for a local model server (llama-server
/// `--api-key`, `LiteLLM`, a `vLLM` proxy). Its own slot, so the OpenAI key never goes to a
/// local server.
pub const LOCAL_KEYCHAIN_SERVICE: &str = "slicerx-local-api-key";
/// Keychain account name of the local server key.
pub const LOCAL_KEYCHAIN_ACCOUNT: &str = "slicerx";

/// Where keys come from. [`SystemKeySource`] is the real one; tests inject their own so
/// they never touch the user's keychain or the process environment.
pub trait KeySource: Send + Sync {
    /// Password of the generic keychain item with this service and account, if any.
    fn keychain(&self, service: &str, account: &str) -> Option<String>;
    /// Value of an environment variable, if set.
    fn env(&self, name: &str) -> Option<String>;
}

/// The OS credential store (macOS Keychain, Windows Credential Manager, Secret Service)
/// and the process environment. Keychain reads block, and macOS may ask the user to allow
/// access the first time.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemKeySource;

impl KeySource for SystemKeySource {
    fn keychain(&self, service: &str, account: &str) -> Option<String> {
        // Any keychain error (no item, access refused, no store) falls through to the
        // environment. The error is dropped rather than reported, so it cannot leak. An item
        // the user refused (macOS Deny) is not asked for again until it is written or removed.
        let key = (service.to_owned(), account.to_owned());
        if refused().lock().is_ok_and(|r| r.contains(&key)) {
            return None;
        }
        match keyring::Entry::new(service, account).ok()?.get_password() {
            Ok(v) => Some(v),
            Err(keyring::Error::NoEntry) => None,
            Err(_) => {
                if let Ok(mut r) = refused().lock() {
                    r.insert(key);
                }
                None
            }
        }
    }

    fn env(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
}

/// Keychain items whose read failed with something other than "no item" this session.
fn refused() -> &'static std::sync::Mutex<std::collections::HashSet<(String, String)>> {
    static REFUSED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<(String, String)>>> =
        std::sync::OnceLock::new();
    REFUSED.get_or_init(Default::default)
}

/// Asks for a refused item again, after it was written or removed.
pub(crate) fn forget_refusal(service: &str, account: &str) {
    if let Ok(mut r) = refused().lock() {
        r.remove(&(service.to_owned(), account.to_owned()));
    }
}

/// An API key. `Debug` never prints it.
pub(crate) struct ApiKey(String);

impl ApiKey {
    pub(crate) fn new(value: String) -> Self {
        Self(value)
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApiKey([redacted])")
    }
}

/// Supported providers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Provider {
    /// `openai`: api.openai.com over https, with the user's key.
    OpenAi,
    /// `anthropic`: api.anthropic.com over https, with the user's key sent as `x-api-key`.
    Anthropic,
    /// `openai-compatible`: a model server (Ollama, LM Studio, llama.cpp, vLLM) on loopback
    /// or the home network over http. Only the optional local key is sent, so a local
    /// process can never receive the OpenAI key.
    OpenAiCompatible,
}

impl Provider {
    pub(crate) fn parse(id: &str) -> Option<Self> {
        match id {
            "openai" => Some(Provider::OpenAi),
            "anthropic" => Some(Provider::Anthropic),
            "openai-compatible" => Some(Provider::OpenAiCompatible),
            _ => None,
        }
    }
}

/// The key in the keychain first, then each environment variable in order. Blank values
/// count as missing.
fn lookup(src: &(impl KeySource + ?Sized), service: &str, account: &str, env: &[&str]) -> Option<ApiKey> {
    let usable = |v: String| {
        let t = v.trim();
        (!t.is_empty()).then(|| ApiKey(t.to_owned()))
    };
    src.keychain(service, account)
        .and_then(usable)
        .or_else(|| env.iter().find_map(|name| src.env(name).and_then(usable)))
}

/// The OpenAI key: keychain first, then `SLICERX_OPENAI_API_KEY`, then `OPENAI_API_KEY`.
/// Blank values count as missing.
pub(crate) fn openai_key(src: &(impl KeySource + ?Sized)) -> Option<ApiKey> {
    lookup(
        src,
        OPENAI_KEYCHAIN_SERVICE,
        OPENAI_KEYCHAIN_ACCOUNT,
        &OPENAI_KEY_ENV,
    )
}

/// The Anthropic key: keychain first, then `SLICERX_ANTHROPIC_API_KEY`, then `ANTHROPIC_API_KEY`.
pub(crate) fn anthropic_key(src: &(impl KeySource + ?Sized)) -> Option<ApiKey> {
    lookup(
        src,
        ANTHROPIC_KEYCHAIN_SERVICE,
        ANTHROPIC_KEYCHAIN_ACCOUNT,
        &ANTHROPIC_KEY_ENV,
    )
}

/// The optional local server key: keychain only, no environment fallback. Blank counts as
/// missing, and most servers need none.
pub(crate) fn local_key(src: &(impl KeySource + ?Sized)) -> Option<ApiKey> {
    lookup(src, LOCAL_KEYCHAIN_SERVICE, LOCAL_KEYCHAIN_ACCOUNT, &[])
}
