// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Error text from providers. OpenAI echoes a masked form of a wrong key in its 401 reply,
//! and a local server may echo anything, so the text is cut down and scrubbed before it
//! becomes an [`crate::Error::Http`].

/// Longest message kept from a provider error, in characters.
pub(crate) const MAX_MESSAGE_CHARS: usize = 300;

const REDACTED: &str = "[redacted]";

/// Picks the provider's own message out of an error body (`{"error": {"message": ...}}`
/// for OpenAI, `{"error": "..."}` for Ollama, `{"message": ...}` elsewhere, else the raw
/// text), then redacts and truncates it. `known_key` is the key that was sent, if any.
pub(crate) fn provider_message(body: &[u8], known_key: Option<&str>) -> String {
    let parsed: Option<serde_json::Value> = serde_json::from_slice(body).ok();
    let from_json = parsed.as_ref().and_then(|v| {
        v.pointer("/error/message")
            .or_else(|| v.get("error"))
            .or_else(|| v.get("message"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    });
    let text = from_json.unwrap_or_else(|| String::from_utf8_lossy(body).trim().to_owned());
    truncate(&redact(&text, known_key))
}

/// Replaces the known key and every run that looks like a credential: anything starting
/// with `sk-` or `sk_`, the word after `Bearer`, and any run of 20 or more key characters
/// that mixes letters and digits.
pub(crate) fn redact(text: &str, known_key: Option<&str>) -> String {
    let text = match known_key {
        Some(k) if !k.is_empty() => text.replace(k, REDACTED),
        _ => text.to_owned(),
    };
    let mut out = String::with_capacity(text.len());
    let mut run = String::new();
    let mut after_bearer = false;
    for c in text.chars() {
        if is_key_char(c) {
            run.push(c);
            continue;
        }
        flush(&mut out, &mut run, &mut after_bearer);
        out.push(c);
    }
    flush(&mut out, &mut run, &mut after_bearer);
    out
}

fn is_key_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '*')
}

fn flush(out: &mut String, run: &mut String, after_bearer: &mut bool) {
    if run.is_empty() {
        return;
    }
    let is_bearer = run.eq_ignore_ascii_case("bearer");
    if *after_bearer || looks_like_key(run) {
        out.push_str(REDACTED);
    } else {
        out.push_str(run);
    }
    *after_bearer = is_bearer;
    run.clear();
}

fn looks_like_key(run: &str) -> bool {
    let lower = run.to_ascii_lowercase();
    if lower.starts_with("sk-") || lower.starts_with("sk_") {
        return true;
    }
    run.chars().count() >= 20
        && run.chars().any(|c| c.is_ascii_digit())
        && run.chars().any(|c| c.is_ascii_alphabetic())
}

fn truncate(text: &str) -> String {
    text.chars().take(MAX_MESSAGE_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_401_message_loses_the_masked_key() {
        let body = br#"{"error":{"message":"Incorrect API key provided: sk-proj-AbCd************************************wxyz. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key"}}"#;
        let msg = provider_message(body, None);
        assert_eq!(
            msg,
            "Incorrect API key provided: [redacted]. You can find your API key at https://platform.openai.com/account/api-keys."
        );
    }

    #[test]
    fn known_key_bearer_and_long_tokens_are_redacted() {
        let key = "plainkeywithoutprefix";
        let text = format!(
            "got {key}, header Bearer abc.def, token 9f8e7d6c5b4a39281706f5e4, sk_live_12 and ok words like authorization-required"
        );
        let out = redact(&text, Some(key));
        assert!(!out.contains(key));
        assert!(!out.contains("abc"));
        assert!(!out.contains("9f8e7d6c5b4a"));
        assert!(!out.contains("sk_live"));
        assert!(out.contains("authorization-required"), "{out}");
        assert!(
            out.starts_with("got [redacted], header Bearer [redacted].def"),
            "{out}"
        );
    }

    #[test]
    fn message_shapes_and_truncation() {
        assert_eq!(
            provider_message(br#"{"error":"model not found"}"#, None),
            "model not found"
        );
        assert_eq!(provider_message(br#"{"message":"slow down"}"#, None), "slow down");
        assert_eq!(provider_message(b"  Bad Gateway \n", None), "Bad Gateway");
        let long = format!(r#"{{"error":{{"message":"{}"}}}}"#, "word ".repeat(200));
        assert_eq!(
            provider_message(long.as_bytes(), None).chars().count(),
            MAX_MESSAGE_CHARS
        );
        // Truncation counts characters, not bytes.
        let wide = "\u{e9}".repeat(400);
        assert_eq!(
            provider_message(wide.as_bytes(), None).chars().count(),
            MAX_MESSAGE_CHARS
        );
    }
}
