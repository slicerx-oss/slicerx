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
        // environment. The error is dropped rather than reported, so it cannot leak.
        keyring::Entry::new(service, account).ok()?.get_password().ok()
    }

    fn env(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
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
    /// `openai-compatible`: a local server (Ollama, LM Studio) on loopback over http. No
    /// key is sent, so a local process can never receive the OpenAI key.
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
