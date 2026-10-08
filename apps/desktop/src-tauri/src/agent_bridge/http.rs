// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The bridge's wire: one small HTTP/1.1 request per connection, read from a loopback socket, checked, and answered
//! with JSON. Nothing here touches the app, so every rule (token, Host, Origin, sizes, routes) is tested on its own.
//!
//! Routes: `GET /v1/health` and `POST /v1/call` with `{"tool": "...", "args": {...}}`. Every request carries
//! `Authorization: Bearer <token>`. Answers are `{"ok": true, "result": ...}` or `{"ok": false, "error": {"code",
//! "message"}}`.

use std::io::{BufRead, BufReader, Read, Write};

/// A request body larger than this is refused: tool arguments are small.
pub const MAX_BODY: usize = 1024 * 1024;
/// Header lines past this many, or longer than this, end the request.
const MAX_HEADERS: usize = 64;
const MAX_LINE: usize = 8 * 1024;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    pub path: String,
    /// Header names in lower case.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

impl Response {
    pub fn ok(result: &serde_json::Value) -> Self {
        Self {
            status: 200,
            body: serde_json::json!({ "ok": true, "result": result }).to_string(),
        }
    }

    pub fn error(status: u16, code: &str, message: &str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "ok": false, "error": { "code": code, "message": message } })
                .to_string(),
        }
    }
}

/// Why a tool call failed: a code an agent can branch on and a sentence for a person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
}

impl ToolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn status(&self) -> u16 {
        match self.code {
            "unknown_tool" | "not_found" => 404,
            "invalid_input" => 400,
            "refused" => 403,
            "timeout" => 504,
            "page_unavailable" => 503,
            _ => 500,
        }
    }
}

/// Reads one request, or returns the answer for something that is not a request this server takes.
pub fn read_request(stream: impl Read) -> Result<Request, Response> {
    let bad = |m: &str| Response::error(400, "bad_request", m);
    let mut reader = BufReader::new(stream.take((MAX_BODY + MAX_HEADERS * MAX_LINE + MAX_LINE) as u64));
    let mut line = String::new();
    read_line(&mut reader, &mut line).map_err(|_| bad("no request line"))?;
    let mut parts = line.split_whitespace();
    let (Some(method), Some(path), Some(version)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(bad("malformed request line"));
    };
    if !version.starts_with("HTTP/1.") {
        return Err(bad("HTTP/1.x only"));
    }
    let mut req = Request {
        method: method.to_owned(),
        path: path.to_owned(),
        ..Request::default()
    };
    loop {
        line.clear();
        read_line(&mut reader, &mut line).map_err(|_| bad("headers cut short"))?;
        let l = line.trim_end_matches(['\r', '\n']);
        if l.is_empty() {
            break;
        }
        if req.headers.len() >= MAX_HEADERS {
            return Err(bad("too many headers"));
        }
        let Some((k, v)) = l.split_once(':') else {
            return Err(bad("malformed header"));
        };
        req.headers
            .push((k.trim().to_ascii_lowercase(), v.trim().to_owned()));
    }
    if req.header("transfer-encoding").is_some() {
        return Err(bad("send a Content-Length body"));
    }
    let len = match req.header("content-length") {
        None => 0,
        Some(v) => v.parse::<usize>().map_err(|_| bad("bad Content-Length"))?,
    };
    if len > MAX_BODY {
        return Err(Response::error(413, "too_large", "the request body is over 1 MB"));
    }
    req.body = vec![0; len];
    reader
        .read_exact(&mut req.body)
        .map_err(|_| bad("body cut short"))?;
    Ok(req)
}

fn read_line(reader: &mut impl BufRead, line: &mut String) -> std::io::Result<()> {
    let mut buf = Vec::new();
    let n = reader.take(MAX_LINE as u64).read_until(b'\n', &mut buf)?;
    if n == 0 || !buf.ends_with(b"\n") {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    *line = String::from_utf8(buf).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidData))?;
    Ok(())
}

pub fn write_response(mut stream: impl Write, res: &Response) -> std::io::Result<()> {
    let reason = match res.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Internal Server Error",
    };
    write!(
        stream,
        "HTTP/1.1 {} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
        res.status,
        res.body.len(),
        res.body
    )?;
    stream.flush()
}

/// Compares in time that depends only on the lengths, so a wrong token's prefix leaks nothing.
pub fn same_secret(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The checks every request passes before it reaches a tool: the token, a Host header naming this loopback port
/// (a web page that rebinds a name to 127.0.0.1 sends its own name), and no Origin (browsers send one, agents do not).
pub fn admit(req: &Request, token: &str, port: u16) -> Result<(), Response> {
    let bearer = req
        .header("authorization")
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if bearer.is_empty() || !same_secret(bearer.trim(), token) {
        return Err(Response::error(
            401,
            "unauthorized",
            "a valid bearer token is required",
        ));
    }
    let host = req.header("host").unwrap_or("");
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return Err(Response::error(
            403,
            "forbidden",
            "the Host header must name this loopback port",
        ));
    }
    if req.header("origin").is_some() {
        return Err(Response::error(
            403,
            "forbidden",
            "requests from web pages are refused",
        ));
    }
    Ok(())
}

/// Routes an admitted request. `call` runs a tool by name; `health` describes the running app.
pub fn route(
    req: &Request,
    health: impl FnOnce() -> serde_json::Value,
    call: impl FnOnce(&str, serde_json::Value) -> Result<serde_json::Value, ToolError>,
) -> Response {
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/v1/health") => Response::ok(&health()),
        ("POST", "/v1/call") => {
            let json = req
                .header("content-type")
                .is_some_and(|t| t.split(';').next().unwrap_or("").trim() == "application/json");
            if !json {
                return Response::error(415, "bad_request", "send Content-Type: application/json");
            }
            let Ok(body) = serde_json::from_slice::<serde_json::Value>(&req.body) else {
                return Response::error(400, "bad_request", "the body is not JSON");
            };
            let Some(tool) = body.get("tool").and_then(|t| t.as_str()) else {
                return Response::error(400, "bad_request", "name a tool");
            };
            let args = body.get("args").cloned().unwrap_or_else(|| serde_json::json!({}));
            if !args.is_object() {
                return Response::error(400, "bad_request", "args must be an object");
            }
            match call(tool, args) {
                Ok(v) => Response::ok(&v),
                Err(e) => Response::error(e.status(), e.code, &e.message),
            }
        }
        (_, "/v1/health" | "/v1/call") => Response::error(405, "bad_request", "wrong method"),
        _ => Response::error(404, "not_found", "no such route"),
    }
}

/// One connection, start to end: read, admit, route, answer.
pub fn serve(
    stream: impl Read + Write,
    token: &str,
    port: u16,
    health: impl FnOnce() -> serde_json::Value,
    call: impl FnOnce(&str, serde_json::Value) -> Result<serde_json::Value, ToolError>,
) -> std::io::Result<()> {
    let mut stream = stream;
    let res = match read_request(&mut stream) {
        Err(res) => res,
        Ok(req) => match admit(&req, token, port) {
            Err(res) => res,
            Ok(()) => route(&req, health, call),
        },
    };
    write_response(&mut stream, &res)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";
    const PORT: u16 = 47_700;

    fn raw(method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> Vec<u8> {
        let mut s = format!("{method} {path} HTTP/1.1\r\n");
        for (k, v) in headers {
            s.push_str(&format!("{k}: {v}\r\n"));
        }
        if !body.is_empty() {
            s.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        s.push_str("\r\n");
        s.push_str(body);
        s.into_bytes()
    }

    fn good(extra: &[(&'static str, &'static str)]) -> Vec<(&'static str, String)> {
        let mut h = vec![
            ("Host", format!("127.0.0.1:{PORT}")),
            ("Authorization", format!("Bearer {TOKEN}")),
            ("Content-Type", "application/json".to_owned()),
        ];
        h.extend(extra.iter().map(|(k, v)| (*k, (*v).to_owned())));
        h
    }

    struct Duplex {
        input: std::io::Cursor<Vec<u8>>,
        output: Vec<u8>,
    }
    impl Read for Duplex {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.input.read(buf)
        }
    }
    impl Write for Duplex {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.output.write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// Runs one request through `serve` with a tool that echoes its name and arguments.
    fn exchange(bytes: Vec<u8>) -> (u16, serde_json::Value) {
        let mut d = Duplex {
            input: std::io::Cursor::new(bytes),
            output: Vec::new(),
        };
        serve(
            &mut d,
            TOKEN,
            PORT,
            || serde_json::json!({ "app": "test" }),
            |tool, args| match tool {
                "echo" => Ok(serde_json::json!({ "tool": tool, "args": args })),
                "slow" => Err(ToolError::new("timeout", "took too long")),
                _ => Err(ToolError::new("unknown_tool", format!("no tool {tool}"))),
            },
        )
        .unwrap();
        let text = String::from_utf8(d.output).unwrap();
        let status: u16 = text[9..12].parse().unwrap();
        assert!(text.contains("Content-Type: application/json\r\n"));
        assert!(text.contains("Connection: close\r\n"));
        let body = text.split("\r\n\r\n").nth(1).unwrap();
        (status, serde_json::from_str(body).unwrap())
    }

    fn call(headers: &[(&str, String)], body: &str) -> (u16, serde_json::Value) {
        let h: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
        exchange(raw("POST", "/v1/call", &h, body))
    }

    #[test]
    fn a_tool_call_with_the_token_runs_and_answers_json() {
        let (status, v) = call(&good(&[]), r#"{"tool":"echo","args":{"testid":"vault-tab"}}"#);
        assert_eq!(status, 200);
        assert_eq!(v["ok"], true);
        assert_eq!(v["result"]["tool"], "echo");
        assert_eq!(v["result"]["args"]["testid"], "vault-tab");
    }

    #[test]
    fn missing_args_are_an_empty_object() {
        let (status, v) = call(&good(&[]), r#"{"tool":"echo"}"#);
        assert_eq!(status, 200);
        assert_eq!(v["result"]["args"], serde_json::json!({}));
    }

    #[test]
    fn health_needs_the_token_too() {
        let host = format!("127.0.0.1:{PORT}");
        let (status, _) = exchange(raw("GET", "/v1/health", &[("Host", &host)], ""));
        assert_eq!(status, 401);
        let auth = format!("Bearer {TOKEN}");
        let (status, v) = exchange(raw(
            "GET",
            "/v1/health",
            &[("Host", &host), ("Authorization", &auth)],
            "",
        ));
        assert_eq!(status, 200);
        assert_eq!(v["result"]["app"], "test");
    }

    #[test]
    fn a_missing_or_wrong_token_is_refused_before_any_tool_runs() {
        let mut h = good(&[]);
        h.retain(|(k, _)| *k != "Authorization");
        assert_eq!(call(&h, r#"{"tool":"echo"}"#).0, 401);
        let mut wrong = good(&[]);
        wrong[1].1 = format!("Bearer {}", "f".repeat(TOKEN.len()));
        let (status, v) = call(&wrong, r#"{"tool":"echo"}"#);
        assert_eq!(status, 401);
        assert_eq!(v["error"]["code"], "unauthorized");
        let mut short = good(&[]);
        short[1].1 = "Bearer 0123".to_owned();
        assert_eq!(call(&short, r#"{"tool":"echo"}"#).0, 401);
        let mut basic = good(&[]);
        basic[1].1 = format!("Basic {TOKEN}");
        assert_eq!(call(&basic, r#"{"tool":"echo"}"#).0, 401);
    }

    #[test]
    fn a_foreign_host_or_a_browser_origin_is_refused() {
        let mut h = good(&[]);
        h[0].1 = format!("evil.example:{PORT}");
        assert_eq!(call(&h, r#"{"tool":"echo"}"#).0, 403);
        let mut other_port = good(&[]);
        other_port[0].1 = "127.0.0.1:80".to_owned();
        assert_eq!(call(&other_port, r#"{"tool":"echo"}"#).0, 403);
        let mut localhost = good(&[]);
        localhost[0].1 = format!("localhost:{PORT}");
        assert_eq!(call(&localhost, r#"{"tool":"echo"}"#).0, 200);
        let (status, v) = call(&good(&[("Origin", "https://evil.example")]), r#"{"tool":"echo"}"#);
        assert_eq!(status, 403);
        assert_eq!(v["error"]["code"], "forbidden");
    }

    #[test]
    fn bodies_must_be_json_objects_with_a_tool() {
        let mut text = good(&[]);
        text[2].1 = "text/plain".to_owned();
        assert_eq!(call(&text, r#"{"tool":"echo"}"#).0, 415);
        assert_eq!(call(&good(&[]), "not json").0, 400);
        assert_eq!(call(&good(&[]), r#"{"args":{}}"#).0, 400);
        assert_eq!(call(&good(&[]), r#"{"tool":"echo","args":[1]}"#).0, 400);
    }

    #[test]
    fn tool_errors_keep_their_code_and_status() {
        let (status, v) = call(&good(&[]), r#"{"tool":"nope"}"#);
        assert_eq!(status, 404);
        assert_eq!(v["error"]["code"], "unknown_tool");
        let (status, v) = call(&good(&[]), r#"{"tool":"slow"}"#);
        assert_eq!(status, 504);
        assert_eq!(v["error"]["code"], "timeout");
    }

    #[test]
    fn unknown_routes_and_methods_are_refused() {
        let h = good(&[]);
        let hv: Vec<(&str, &str)> = h.iter().map(|(k, v)| (*k, v.as_str())).collect();
        assert_eq!(exchange(raw("GET", "/v1/call", &hv, "")).0, 405);
        assert_eq!(exchange(raw("POST", "/admin", &hv, "{}")).0, 404);
    }

    #[test]
    fn oversized_chunked_and_malformed_requests_are_refused() {
        let big = format!("Content-Length: {}\r\n", MAX_BODY + 1);
        let mut bytes = format!("POST /v1/call HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\n{big}\r\n").into_bytes();
        bytes.extend(std::iter::repeat_n(b'x', 16));
        assert_eq!(exchange(bytes).0, 413);
        let chunked = format!(
            "POST /v1/call HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"
        );
        assert_eq!(exchange(chunked.into_bytes()).0, 400);
        assert_eq!(exchange(b"garbage\r\n\r\n".to_vec()).0, 400);
        assert_eq!(exchange(b"GET / SPDY/3\r\n\r\n".to_vec()).0, 400);
        assert_eq!(exchange(b"POST /v1/call HTTP/1.1\r\nHost: x".to_vec()).0, 400);
        let short =
            format!("POST /v1/call HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nContent-Length: 50\r\n\r\n{{}}");
        assert_eq!(exchange(short.into_bytes()).0, 400);
    }

    #[test]
    fn secrets_compare_by_content_and_length() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abc", "abd"));
        assert!(!same_secret("abc", "abcd"));
        assert!(!same_secret("", "a"));
    }
}
