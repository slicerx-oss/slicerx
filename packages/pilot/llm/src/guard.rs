// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Request checks that run before any key is read, so a hostile request built by a
//! provider adapter (or by anything that can reach the host command) cannot send the key
//! to another host or read it back through its own headers.
use std::collections::BTreeMap;

use reqwest::Url;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use crate::cloud::MimirCloud;
use crate::error::{Error, Result};
use crate::keys::Provider;

/// Headers the transport sets itself.
const FORBIDDEN_HEADERS: [&str; 5] = [
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "anthropic-version",
    "x-sx-install",
];

/// True for the loopback names a local server answers on.
fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost")
}

/// True for a home-network host: a private IPv4 address (10/8, 172.16/12, 192.168/16), a
/// shared-address one (100.64/10, which Tailscale uses) or an mDNS `.local` name. Public addresses and other names never pass.
fn is_home_network(host: &str) -> bool {
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        let [a, b, ..] = ip.octets();
        return ip.is_private() || (a == 100 && (64..=127).contains(&b));
    }
    host.len() > ".local".len()
        && host
            .get(host.len() - ".local".len()..)
            .is_some_and(|tail| tail.eq_ignore_ascii_case(".local"))
}

/// Parses `raw` and checks it against the provider's allowlist: `https://api.openai.com`
/// for `openai`, `https://api.anthropic.com` for `anthropic`, and for `openai-compatible`
/// `http://127.0.0.1`, `http://localhost`, a private IPv4 address or a `.local` name on any
/// port, and for `mimir-cloud` exactly the proxy's model endpoint on the host set at startup
/// ([`crate::cloud::set_mimir_cloud`]; nothing set refuses every URL). User info in the URL is
/// always refused.
pub(crate) fn check_url(provider: Provider, provider_id: &str, raw: &str) -> Result<Url> {
    check_url_in(provider, provider_id, raw, crate::cloud::mimir_cloud())
}

/// [`check_url`] with the mimir cloud host given, for tests.
pub(crate) fn check_url_in(
    provider: Provider,
    provider_id: &str,
    raw: &str,
    cloud: Option<&MimirCloud>,
) -> Result<Url> {
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
            Provider::OpenAiCompatible => {
                url.scheme() == "http" && (is_loopback(host) || is_home_network(host))
            }
            Provider::MimirCloud => cloud.is_some_and(|c| c.allows(&url)),
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

/// Like [`check_url`] for `openai-compatible`, but loopback only. The auto-detect probes use
/// it: they look for Ollama and LM Studio on this computer and never reach out to the network.
pub(crate) fn check_loopback_url(raw: &str) -> Result<Url> {
    let url = check_url(Provider::OpenAiCompatible, "openai-compatible", raw)?;
    if is_loopback(url.host_str().unwrap_or_default()) {
        Ok(url)
    } else {
        Err(Error::UrlNotAllowed {
            provider: "openai-compatible".to_owned(),
            host: url.host_str().unwrap_or_default().to_owned(),
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

    const REGISTER_KEY: &str = "slicerx-test-key-0123";

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
            (Provider::OpenAiCompatible, "http://192.168.1.20:11434/v1", true),
            (Provider::OpenAiCompatible, "http://10.0.0.5:8080/v1", true),
            (Provider::OpenAiCompatible, "http://172.16.4.2:8080/v1", true),
            (Provider::OpenAiCompatible, "http://100.101.102.103:8080/v1", true),
            (Provider::OpenAiCompatible, "http://100.128.0.1:8080/v1", false),
            (Provider::OpenAiCompatible, "http://172.32.0.1:8080/v1", false),
            (Provider::OpenAiCompatible, "http://8.8.8.8:8080/v1", false),
            (Provider::OpenAiCompatible, "http://169.254.1.1/v1", false),
            (Provider::OpenAiCompatible, "http://studio.local:8080/v1", true),
            (Provider::OpenAiCompatible, "http://.local/v1", false),
            (
                Provider::OpenAiCompatible,
                "http://192.168.1.20.evil.example/v1",
                false,
            ),
            (Provider::OpenAiCompatible, "https://192.168.1.20:8080/v1", false),
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
    fn mimir_cloud_allows_only_its_endpoint() {
        let cloud = MimirCloud::new("https://abcdefghijklmnop.supabase.co", "slicerx", REGISTER_KEY).unwrap();
        let cases = [
            (
                "https://abcdefghijklmnop.supabase.co/functions/v1/mimir/v1/messages",
                true,
            ),
            (
                "https://ABCDEFGHIJKLMNOP.supabase.co/functions/v1/mimir/v1/messages",
                true,
            ),
            (
                "https://abcdefghijklmnop.supabase.co:443/functions/v1/mimir/v1/messages",
                true,
            ),
            (
                "http://abcdefghijklmnop.supabase.co/functions/v1/mimir/v1/messages",
                false,
            ),
            (
                "https://abcdefghijklmnop.supabase.co:8443/functions/v1/mimir/v1/messages",
                false,
            ),
            (
                "https://abcdefghijklmnop.supabase.co/functions/v1/mimir/register",
                false,
            ),
            (
                "https://abcdefghijklmnop.supabase.co/functions/v1/mimir/v1/messages/",
                false,
            ),
            (
                "https://abcdefghijklmnop.supabase.co/functions/v1/mimir/v1/messages?x=1",
                false,
            ),
            (
                "https://abcdefghijklmnop.supabase.co/functions/v1/mimir/v1/messages#x",
                false,
            ),
            (
                "https://abcdefghijklmnop.supabase.co/functions/v1/other/v1/messages",
                false,
            ),
            (
                "https://abcdefghijklmnop.supabase.co/functions/v1/mimir/../mimir/v1/messages",
                true,
            ),
            (
                "https://abcdefghijklmnop.supabase.co/functions/v1/mimir/v1/%6Dessages",
                false,
            ),
            (
                "https://u:p@abcdefghijklmnop.supabase.co/functions/v1/mimir/v1/messages",
                false,
            ),
            ("https://other.supabase.co/functions/v1/mimir/v1/messages", false),
            (
                "https://abcdefghijklmnop.supabase.co.evil.example/functions/v1/mimir/v1/messages",
                false,
            ),
            (
                "https://abcdefghijklmnop.supabase.co./functions/v1/mimir/v1/messages",
                false,
            ),
            ("https://api.anthropic.com/v1/messages", false),
        ];
        for (url, ok) in cases {
            assert_eq!(
                check_url_in(Provider::MimirCloud, "mimir-cloud", url, Some(&cloud)).is_ok(),
                ok,
                "{url}"
            );
        }
        // nothing set: not available anywhere
        assert!(
            check_url_in(
                Provider::MimirCloud,
                "mimir-cloud",
                "https://abcdefghijklmnop.supabase.co/functions/v1/mimir/v1/messages",
                None
            )
            .is_err()
        );
        // the proxy never opens another provider's host
        assert!(
            check_url_in(
                Provider::Anthropic,
                "anthropic",
                "https://abcdefghijklmnop.supabase.co/functions/v1/mimir/v1/messages",
                Some(&cloud)
            )
            .is_err()
        );
    }

    #[test]
    fn mimir_cloud_host_must_be_https() {
        assert!(MimirCloud::new("https://x.supabase.co/rest/v1", "slicerx", REGISTER_KEY).is_ok());
        assert_eq!(
            MimirCloud::new("https://x.supabase.co/anything", "slicerx", REGISTER_KEY)
                .unwrap()
                .messages_url(),
            "https://x.supabase.co/functions/v1/mimir/v1/messages"
        );
        assert!(MimirCloud::new("http://x.supabase.co", "slicerx", REGISTER_KEY).is_err());
        assert!(MimirCloud::new("https://u:p@x.supabase.co", "slicerx", REGISTER_KEY).is_err());
        assert!(MimirCloud::new("not a url", "slicerx", REGISTER_KEY).is_err());
        assert!(MimirCloud::new("https://x.supabase.co", "Bad Edition", REGISTER_KEY).is_err());
        assert!(MimirCloud::new("https://x.supabase.co", "", REGISTER_KEY).is_err());
        // the build's registration key has the proxy's shape, or the cloud is off
        assert!(MimirCloud::new("https://x.supabase.co", "slicerx", "short").is_err());
        assert!(MimirCloud::new("https://x.supabase.co", "slicerx", "has a space in it ok").is_err());
        assert!(MimirCloud::new("https://x.supabase.co", "slicerx", &"k".repeat(129)).is_err());
        // and never shows in a debug print
        let c = MimirCloud::new("https://x.supabase.co", "slicerx", REGISTER_KEY).unwrap();
        assert!(!format!("{c:?}").contains(REGISTER_KEY));
        // a local stack in debug builds (tests are one), never another http host
        assert_eq!(
            MimirCloud::new("http://127.0.0.1:54321", "slicerx", REGISTER_KEY).is_ok(),
            cfg!(debug_assertions)
        );
        assert!(MimirCloud::new("http://localhost:54321", "slicerx", REGISTER_KEY).is_err());
        assert!(MimirCloud::new("http://192.168.1.2:54321", "slicerx", REGISTER_KEY).is_err());
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
            "x-sx-install",
            "X-SX-Install",
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
