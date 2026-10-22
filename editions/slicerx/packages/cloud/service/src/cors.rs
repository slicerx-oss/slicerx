// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Cross-origin access for the apps' own pages only: the desktop app's
//! webview and the edition's web app. Requests carry a bearer token, never
//! cookies, so credentials mode stays off. Any other origin gets no CORS
//! headers at all, so a browser keeps its page from reading the answer.

use std::sync::Arc;

use axum::Router;
use axum::extract::Request;
use axum::http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    ACCESS_CONTROL_EXPOSE_HEADERS, ACCESS_CONTROL_MAX_AGE, ACCESS_CONTROL_REQUEST_METHOD, ORIGIN, VARY,
};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

/// The desktop app's page origins: macOS and Linux serve it from
/// `tauri://localhost`, Windows from `http://tauri.localhost`, or
/// `https://tauri.localhost` with Tauri's HTTPS scheme on.
pub const DESKTOP_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];

const ALLOW_METHODS: &str = "GET, PUT, POST, OPTIONS";
/// What the client sends: the bearer token, JSON or mesh bytes, and a
/// compressed mesh body.
const ALLOW_HEADERS: &str = "authorization, content-type, content-encoding";

/// The origins allowed to call the API: the desktop app's, and the web app's
/// own origin (`apps.web.origin` in the edition config) when it has one.
pub fn allowed_origins(web_origin: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = DESKTOP_ORIGINS.iter().map(|&o| o.to_owned()).collect();
    if let Some(web) = web_origin.and_then(origin_of) {
        out.push(web);
    }
    out
}

/// `scheme://host[:port]` of a URL, without a path or trailing slash.
fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.trim().split_once("://")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    // Browsers send the scheme and host in lowercase.
    (!scheme.is_empty() && !host.is_empty()).then(|| format!("{scheme}://{host}").to_ascii_lowercase())
}

/// The routes with CORS for `origins` only: a preflight from one of them is
/// answered here, and its other requests get the origin echoed back.
pub fn with_cors(routes: Router, origins: Vec<String>) -> Router {
    let origins: Arc<[String]> = origins.into();
    routes.layer(axum::middleware::from_fn(move |req: Request, next: Next| {
        let origins = origins.clone();
        async move {
            let allowed = req
                .headers()
                .get(ORIGIN)
                .and_then(|v| v.to_str().ok())
                .filter(|o| origins.iter().any(|a| a == o))
                .and_then(|o| HeaderValue::from_str(o).ok());
            let Some(origin) = allowed else {
                return next.run(req).await;
            };
            if req.method() == Method::OPTIONS && req.headers().contains_key(ACCESS_CONTROL_REQUEST_METHOD) {
                let mut res = StatusCode::NO_CONTENT.into_response();
                let h = res.headers_mut();
                h.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
                h.insert(
                    ACCESS_CONTROL_ALLOW_METHODS,
                    HeaderValue::from_static(ALLOW_METHODS),
                );
                h.insert(
                    ACCESS_CONTROL_ALLOW_HEADERS,
                    HeaderValue::from_static(ALLOW_HEADERS),
                );
                h.insert(ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
                h.append(VARY, HeaderValue::from_static("origin"));
                return res;
            }
            let mut res: Response = next.run(req).await;
            let h = res.headers_mut();
            h.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
            h.insert(
                ACCESS_CONTROL_EXPOSE_HEADERS,
                HeaderValue::from_static("retry-after"),
            );
            h.append(VARY, HeaderValue::from_static("origin"));
            res
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_web_origin_is_its_scheme_host_and_port() {
        let o = allowed_origins(Some("https://Slicer.example:8443/studio/"));
        assert_eq!(o.last().map(String::as_str), Some("https://slicer.example:8443"));
        assert_eq!(allowed_origins(None).len(), DESKTOP_ORIGINS.len());
        assert_eq!(allowed_origins(Some("not a url")).len(), DESKTOP_ORIGINS.len());
    }
}
