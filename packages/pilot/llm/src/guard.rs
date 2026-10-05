// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Request checks that run before any key is read, so a hostile request built by a
//! provider adapter (or by anything that can reach the host command) cannot send the key
//! to another host or read it back through its own headers.
use std::collections::BTreeMap;

use reqwest::Url;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use crate::error::{Error, Result};
use crate::keys::Provider;

/// Headers the transport sets itself.
const FORBIDDEN_HEADERS: [&str; 4] = [
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "anthropic-version",
];

/// Parses `raw` and checks it against the provider's allowlist: `https://api.openai.com`
/// for `openai`, `https://api.anthropic.com` for `anthropic`, `http://127.0.0.1` or `http://localhost` on any port for
/// `openai-compatible`. User info in the URL is always refused.
pub(crate) fn check_url(provider: Provider, provider_id: &str, raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| Error::InvalidUrl {
        provider: provider_id.to_owned(),
    })?;
    let host = url.host_str().unwrap_or_default();
    let no_user_info = url.username().is_empty() && url.password().is_none();
    let allowed = no_user_info
        && match provider {
            Provider::OpenAi => {
                url.scheme() == "https" && url.domain() == Some("api.openai.com") && url.port().is_none()
            }
            Provider::Anthropic => {
                url.scheme() == "https" && url.domain() == Some("api.anthropic.com") && url.port().is_none()
            }
            Provider::OpenAiCompatible => url.scheme() == "http" && matches!(host, "127.0.0.1" | "localhost"),
        };
    if allowed {
        Ok(url)
    } else {
        Err(Error::UrlNotAllowed {
            provider: provider_id.to_owned(),
            host: host.to_owned(),
        })
    }
}

/// Converts the request headers, refusing `authorization` and `proxy-authorization` in
/// any letter case.
pub(crate) fn check_headers(headers: &BTreeMap<String, String>) -> Result<HeaderMap> {
    let mut out = HeaderMap::new();
    for (name, value) in headers {
        let invalid = || Error::InvalidHeader { name: name.clone() };
        let header = HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid())?;
        if FORBIDDEN_HEADERS.contains(&header.as_str()) {
            return Err(Error::ForbiddenHeader {
                name: header.as_str().to_owned(),
            });
        }
        let value = HeaderValue::from_str(value).map_err(|_| invalid())?;
        out.insert(header, value);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_allowlist() {
        let cases = [
            (Provider::Anthropic, "https://api.anthropic.com/v1/messages", true),
            (
                Provider::Anthropic,
                "https://api.anthropic.com:8443/v1/messages",
                false,
            ),
            (Provider::Anthropic, "http://api.anthropic.com/v1/messages", false),
            (
                Provider::Anthropic,
                "https://api.anthropic.com.evil.example/v1/messages",
                false,
            ),
            (Provider::Anthropic, "https://api.openai.com/v1/responses", false),
            (Provider::OpenAi, "https://api.anthropic.com/v1/messages", false),
            (Provider::OpenAi, "https://api.openai.com/v1/responses", true),
            (Provider::OpenAi, "https://API.OpenAI.com/v1/responses", true),
            (Provider::OpenAi, "https://api.openai.com:443/v1/responses", true),
            (Provider::OpenAi, "http://api.openai.com/v1/responses", false),
            (
                Provider::OpenAi,
                "https://api.openai.com:8443/v1/responses",
                false,
            ),
            (Provider::OpenAi, "https://api.openai.com.evil.example/v1", false),
            (Provider::OpenAi, "https://evil.example/api.openai.com", false),
            (Provider::OpenAi, "https://api.openai.com@evil.example/v1", false),
            (Provider::OpenAi, "https://user:pw@api.openai.com/v1", false),
            (Provider::OpenAi, "https://api.openai.com./v1", false),
            (Provider::OpenAi, "https://127.0.0.1/v1", false),
            (Provider::OpenAi, "http://localhost:11434/v1", false),
            (
                Provider::OpenAiCompatible,
                "http://127.0.0.1:11434/v1/chat/completions",
                true,
            ),
            (
                Provider::OpenAiCompatible,
                "http://localhost:1234/v1/chat/completions",
                true,
            ),
            (Provider::OpenAiCompatible, "http://localhost/v1", true),
            (Provider::OpenAiCompatible, "https://localhost:1234/v1", false),
            (Provider::OpenAiCompatible, "http://192.168.1.20:11434/v1", false),
            (
                Provider::OpenAiCompatible,
                "http://localhost.evil.example/v1",
                false,
            ),
            (Provider::OpenAiCompatible, "http://127.0.0.1.nip.io/v1", false),
            (Provider::OpenAiCompatible, "http://[::1]:11434/v1", false),
            (Provider::OpenAiCompatible, "http://x@localhost:11434/v1", false),
            (
                Provider::OpenAiCompatible,
                "https://api.openai.com/v1/responses",
                false,
            ),
        ];
        for (provider, url, ok) in cases {
            assert_eq!(check_url(provider, "p", url).is_ok(), ok, "{provider:?} {url}");
        }
        assert!(matches!(
            check_url(Provider::OpenAi, "openai", "not a url"),
            Err(Error::InvalidUrl { .. })
        ));
        assert_eq!(
            check_url(Provider::OpenAi, "openai", "https://evil.example/v1").unwrap_err(),
            Error::UrlNotAllowed {
                provider: "openai".into(),
                host: "evil.example".into()
            }
        );
    }

    #[test]
    fn authorization_headers_are_refused() {
        for name in [
            "authorization",
            "Authorization",
            "AUTHORIZATION",
            "Proxy-Authorization",
            "x-api-key",
            "X-API-Key",
            "Anthropic-Version",
        ] {
            let headers = BTreeMap::from([(name.to_owned(), "Bearer sk-hostile".to_owned())]);
            let err = check_headers(&headers).unwrap_err();
            assert!(matches!(err, Error::ForbiddenHeader { .. }), "{name}: {err:?}");
            assert!(!err.to_string().contains("sk-hostile"));
        }
    }

    #[test]
    fn headers_pass_through_or_fail_as_invalid() {
        let ok = BTreeMap::from([
            ("content-type".to_owned(), "application/json".to_owned()),
            ("OpenAI-Beta".to_owned(), "responses=v1".to_owned()),
        ]);
        let map = check_headers(&ok).unwrap();
        assert_eq!(map.len(), 2);
        assert_eq!(map["openai-beta"], "responses=v1");
        let bad_name = BTreeMap::from([("bad header".to_owned(), "x".to_owned())]);
        assert!(matches!(
            check_headers(&bad_name),
            Err(Error::InvalidHeader { .. })
        ));
        let bad_value = BTreeMap::from([("x-ok".to_owned(), "line\nbreak".to_owned())]);
        assert!(matches!(
            check_headers(&bad_value),
            Err(Error::InvalidHeader { .. })
        ));
    }
}
