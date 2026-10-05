# sx-llm

LLM HTTP transport with key injection. Provider adapters in `packages/pilot` build an `LlmHttpRequest` without a key. This crate checks it, adds `Authorization: Bearer <key>` and streams the raw response body back.

For provider `openai` the key is read at request time, in this order:

1. The macOS Keychain generic password with service `slicerx-openai-api-key` and account `slicerx`. Other operating systems use their native store (Windows Credential Manager, Secret Service) with the same service and account.
2. The environment variable `SLICERX_OPENAI_API_KEY`.
3. The environment variable `OPENAI_API_KEY`.

Blank values count as missing. The key is never cached to disk or logged, and no error text contains it. `chatgpt::set_api_key` saves a pasted key in the Keychain (it checks the shape first) and `chatgpt::clear_api_key` removes it; nothing else writes keys.

Provider `anthropic` reads its key the same way (Keychain service `slicerx-anthropic-api-key`, account `slicerx`, then `SLICERX_ANTHROPIC_API_KEY`, then `ANTHROPIC_API_KEY`) and sends it as `x-api-key` with `anthropic-version: 2023-06-01`, only to `https://api.anthropic.com`. The two keys are never mixed up.

Provider `openai-compatible` (Ollama, LM Studio) is local and gets no key, so a process listening on a local port can never receive the OpenAI key.

## Sign in with ChatGPT

`chatgpt` lets the user's ChatGPT plan pay for `openai` requests. It is written from OpenAI's published protocol. OpenAI's own SDK is under a noncommercial license, so it is not used.

- `connect` runs OpenID Connect with PKCE (S256) against `auth.openai.com`: discovery, a browser sign-in opened through the caller's `open_url`, a callback on `http://127.0.0.1:47616/auth/callback`, and the code exchange. The first sign-in registers the app (`client_id=dynamic_agent_client`, `agent_name_hint`), and the issued client id is kept. Scopes are `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` with resource `https://api.openai.com/v1`. The state is compared in constant time, and forged or stray callbacks are answered with an error page while the wait goes on. The ID token's issuer, audience, expiry and nonce are checked. Its signature is not, because it comes straight from the token endpoint over TLS (OpenID Connect Core 3.1.3.7).
- Tokens live only in the Keychain item `slicerx-chatgpt` / `slicerx`. `Account` is the public view and holds no token. Access tokens are refreshed two minutes before expiry, the rotated refresh token is saved, and a refresh that returns a different account is refused. `disconnect` revokes the refresh token and removes the item.
- `probe` sends three small streaming requests on the plan (text, a function tool, an 8 by 8 PNG) and records which ones completed. `probe_with` also reports each call to a trace.
- `openai_auth` is the one interface. For each `openai` request, `stream` reads what the body needs (tools, `input_image`). It uses the plan when the probe showed the plan accepts all of it, and otherwise the API key. With no key, the plan is tried and the API's answer decides.

Check a real account (opens the browser; prints no token):

```
cargo run -q -p sx-llm --example chatgpt_probe              # keeps the connection
cargo run -q -p sx-llm --example chatgpt_probe -- --sign-out
cargo run -q -p sx-llm --example chatgpt_probe -- --verbose   # each call: path, status, content type, redacted start of an odd body
```

With a saved connection the probe skips the browser. The three probe requests stream, as OpenAI's own client does on the plan route, run at once and give up after 40 seconds each.

## Desktop API (Settings > mimir)

What the desktop app's commands call. Every function takes the store (`&SystemKeySource` in the app) and, for network calls, `Endpoints::openai()?`. Keychain reads and writes can block (macOS may ask once), so call them off the UI thread. Nothing returned holds a token.

| Command | Call | Returns |
| --- | --- | --- |
| Connect your ChatGPT account | `chatgpt::connect(&store, &ConnectOptions { endpoints, redirect_port: DEFAULT_REDIRECT_PORT, app_name: "SlicerX", open_url: &|url| /* Tauri opener */, timeout: Duration::from_secs(300) })`, then `chatgpt::probe(&store, &endpoints)` | `Account` (camelCase JSON: `email`, `name`, `planUsage`, `connectedAt`, `capabilities`) |
| Show the connection | `chatgpt::account(&store)` | `Option<Account>` |
| Which account mimir uses now | `chatgpt::openai_auth(&store, Needs::default())` | `ChatGptPlan`, `ApiKey` or none |
| Disconnect | `chatgpt::disconnect(&store, &endpoints)` | removes the Keychain item even when revocation fails; the error then says to disconnect in ChatGPT settings |
| Paste an API key | `chatgpt::set_api_key(&store, "openai", key)` | checks the shape, saves it in the Keychain |
| Remove the API key | `chatgpt::clear_api_key(&store, "openai")` | |
| Is a key saved | `chatgpt::has_api_key(&store, "openai")` | reads the same item `set_api_key` writes |
| Move an old key | `chatgpt::migrate_api_keys(&store)` | at startup: moves a key older desktop builds kept under service `slicerx-printers` (account `slicerx-openai-api-key` or `slicerx-anthropic-api-key`) to service `slicerx-<provider>-api-key`, account `slicerx`, where the model reads it |
| Model list for the Model setting | `chatgpt::plan_models(&store, &endpoints)` | `Vec<ModelInfo>` (`slug`, `displayName`, `listed`, `hints`) |
| Automatic choice | `chatgpt::pick_tiers(&models)` | `Tiers { huginn, muninn, by }`, or a reason a person has to choose |

The Model setting stores `automatic` (the default, shown as "Automatic (huginn for quick looks, muninn for deep thinking)") or a pinned slug; the assistant reads it from its config (`models` in `PilotConfig`). On the API key, which is billed per token, mimir uses the huginn model for everything; the setting says so.

## Request checks

These run before the key is read:

- The provider must be `openai`, `anthropic` or `openai-compatible`.
- The URL must match the provider's allowlist: `https://api.openai.com` (default port) for `openai`, `https://api.anthropic.com` (default port) for `anthropic`, and `http://127.0.0.1` or `http://localhost` on any port for `openai-compatible`. URLs with user info are refused.
- The request must not carry an `authorization`, `proxy-authorization`, `x-api-key` or `anthropic-version` header in any letter case.

Redirects are not followed and no proxy is used, so the `Authorization` header only goes to the allowed host.

A non-2xx reply becomes `Error::Http { status, message }`. `message` is the provider's own error message (`error.message`, `error` or `message` in the JSON body, else the raw text), cut to 300 characters. The key that was sent, anything starting with `sk-` or `sk_`, the word after `Bearer`, and any run of 20 or more characters that mixes letters and digits are replaced with `[redacted]`.

## Public API

```rust
pub struct LlmHttpRequest { pub provider: String, pub url: String, pub method: HttpMethod, pub headers: BTreeMap<String, String>, pub body: String }

pub async fn stream(req: LlmHttpRequest) -> Result<impl Stream<Item = Result<Bytes, Error>> + Send + 'static, Error>;
pub fn available(provider: &str) -> bool;

// A local model server's listing (GET, loopback http only, no key, 3 s, at most 1 MiB).
pub async fn local_get(url: &str) -> Result<String, Error>;

// Same, over an explicit key source. Tests use these so they never touch the keychain.
pub trait KeySource: Send + Sync {
    fn keychain(&self, service: &str, account: &str) -> Option<String>;
    fn env(&self, name: &str) -> Option<String>;
}
pub struct SystemKeySource;
pub async fn stream_with(keys: &dyn KeySource, req: LlmHttpRequest) -> Result<impl Stream<...>, Error>;
pub fn available_with(keys: &dyn KeySource, provider: &str) -> bool;
```

`LlmHttpRequest` mirrors the TS contract with camelCase serde, and `method` serializes as `"POST"`. `available("openai")` is true when a key is found. `available("openai-compatible")` is always true. `stream` reads the keychain on a blocking thread and needs a tokio runtime.

## Dependencies

- `base64` =0.22.1: base64url for PKCE values and the ID token payload. Already in the lockfile.
- `bytes` =1.12.1: the `Bytes` chunk type in the stream signature.
- `form_urlencoded` =1.2.2: OAuth form bodies. Already in the lockfile through `url`.
- `ring` =0.17.14: random state, nonce and verifier, and SHA-256 for PKCE. Already the TLS provider.
- `futures` =0.3.34: `Stream` and `StreamExt` for mapping the body stream; same version as `sx-connect`.
- `keyring` =4.2.0: keychain read (macOS Keychain through its apple-native store, which the default `v1` feature selects); same version as `sx-connect`.
- `reqwest` =0.13.5, default features off, with `rustls-no-provider` and `stream`: the streaming HTTP client. reqwest 0.13 has no `rustls-tls` feature, and its `rustls` feature pulls in `aws-lc-rs` (a C build), so this crate follows `sx-connect` and uses the `ring` provider.
- `rustls` =0.23.45 with `ring`, `std` and `tls12`: the TLS config handed to reqwest; same features as `sx-connect`.
- `rustls-platform-verifier` =0.7.1: verifies api.openai.com against the OS trust store. It was already in the lockfile through reqwest.
- `serde` =1.0.229: derives for `LlmHttpRequest`.
- `serde_json` =1.0.151: reads provider error bodies.
- `thiserror` =2.0.21: the crate error enum.
- `tokio` =1.53.1 with `rt`, `net`, `io-util` and `time`: `spawn_blocking` for the keychain read, the sign-in callback listener and its timeout. Tests also use `macros`.

Every direct dependency is MIT, Apache-2.0 or dual licensed under both, which `deny.toml` allows.

## Status

Working, with 14 unit tests. None use the internet, the real keychain or the process environment:

- The URL allowlist, including look-alike hosts, user info, wrong scheme or port, and IPv6 loopback.
- Refusal of `authorization` headers in any case, and a check that hostile requests fail before any key is read.
- Key lookup order and `available()` through an injected `KeySource`.
- Redaction and truncation of provider error text, including OpenAI's masked-key 401 message.
- Streaming against a one-shot server on 127.0.0.1: the body comes back intact, no `authorization` header is sent to a local provider, and a 401 with a key in its message becomes a redacted `Error::Http`.

Not verified: a live call to api.openai.com, which needs a real key. Only `openai` and `openai-compatible` are supported. Anthropic Messages would need its own allowlist entry and the `x-api-key` header.
