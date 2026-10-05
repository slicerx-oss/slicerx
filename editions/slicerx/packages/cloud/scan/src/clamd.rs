// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Malware scanning through a `ClamAV` daemon (`clamd`) with the
//! `INSTREAM` command. The daemon runs on the server side; this file only talks to it.
//!
//! `clamd.conf` must allow the biggest upload: `StreamMaxLength` at least as
//! large as `Limits::max_file_bytes` plus the container overhead, and
//! `MaxFileSize` and `MaxScanSize` to match. When the daemon refuses a stream
//! the scan is reported as unavailable and the upload stays in quarantine.

use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

/// The answer of a scanner that did run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AvVerdict {
    Clean,
    /// The signature name the engine reported.
    Infected(String),
}

/// The scanner could not give an answer. The upload is not approved and is
/// scanned again later.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvError(pub String);

impl std::fmt::Display for AvError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AvError {}

/// A malware scanner.
#[async_trait]
pub trait AntiVirus: Send + Sync {
    /// Engine name for the report.
    fn engine(&self) -> &str;
    /// Scans one buffer.
    async fn scan(&self, bytes: &[u8]) -> Result<AvVerdict, AvError>;
    /// Engine and signature database version, when known.
    async fn version(&self) -> Option<String>;
}

/// Where clamd listens.
#[derive(Debug, Clone)]
pub enum ClamdAddr {
    /// `host:port`.
    Tcp(String),
    /// A Unix socket path.
    #[cfg(unix)]
    Unix(PathBuf),
}

impl ClamdAddr {
    /// Reads an address written as `tcp:host:port` or `unix:/path`. A bare
    /// `host:port` is TCP.
    pub fn parse(s: &str) -> Result<Self, String> {
        if let Some(path) = s.strip_prefix("unix:") {
            #[cfg(unix)]
            return Ok(Self::Unix(PathBuf::from(path)));
            #[cfg(not(unix))]
            return Err(format!("unix sockets are not available here: {path}"));
        }
        let hostport = s.strip_prefix("tcp:").unwrap_or(s);
        if hostport
            .rsplit_once(':')
            .is_none_or(|(h, p)| h.is_empty() || p.parse::<u16>().is_err())
        {
            return Err("expected host:port".into());
        }
        Ok(Self::Tcp(hostport.to_owned()))
    }
}

/// A clamd client.
#[derive(Debug, Clone)]
pub struct Clamd {
    addr: ClamdAddr,
    timeout: Duration,
}

const CHUNK: usize = 64 * 1024;

impl Clamd {
    pub fn new(addr: ClamdAddr) -> Self {
        Self {
            addr,
            timeout: Duration::from_secs(120),
        }
    }

    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    async fn talk(&self, command: &[u8], body: Option<&[u8]>) -> Result<String, AvError> {
        let fut = async {
            match &self.addr {
                ClamdAddr::Tcp(a) => {
                    let s = TcpStream::connect(a).await.map_err(|e| io_err(&e))?;
                    exchange(s, command, body).await
                }
                #[cfg(unix)]
                ClamdAddr::Unix(p) => {
                    let s = tokio::net::UnixStream::connect(p).await.map_err(|e| io_err(&e))?;
                    exchange(s, command, body).await
                }
            }
        };
        tokio::time::timeout(self.timeout, fut)
            .await
            .map_err(|_| AvError("clamd did not answer in time".into()))?
    }
}

fn io_err(e: &std::io::Error) -> AvError {
    AvError(format!("cannot talk to clamd: {e}"))
}

async fn exchange<S>(mut s: S, command: &[u8], body: Option<&[u8]>) -> Result<String, AvError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut write_failed = None;
    let sent = async {
        s.write_all(command).await?;
        if let Some(body) = body {
            for chunk in body.chunks(CHUNK) {
                let len = u32::try_from(chunk.len()).unwrap_or(u32::MAX);
                s.write_all(&len.to_be_bytes()).await?;
                s.write_all(chunk).await?;
            }
            s.write_all(&0u32.to_be_bytes()).await?;
        }
        s.flush().await
    }
    .await;
    if let Err(e) = sent {
        // clamd closes the stream after refusing it and says why. Read that
        // reply instead of reporting a broken pipe.
        write_failed = Some(e);
    }
    let mut reply = Vec::new();
    let read = (&mut s).take(4096).read_to_end(&mut reply).await;
    if reply.is_empty() {
        return Err(io_err(&write_failed.or(read.err()).unwrap_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "empty reply")
        })));
    }
    Ok(String::from_utf8_lossy(&reply)
        .trim_matches(|c: char| c == '\0' || c.is_whitespace())
        .to_owned())
}

/// Interprets an `INSTREAM` reply such as `stream: OK` or
/// `stream: Eicar-Test-Signature FOUND`.
fn parse_reply(reply: &str) -> Result<AvVerdict, AvError> {
    let body = reply.strip_prefix("stream:").unwrap_or(reply).trim();
    if body == "OK" {
        return Ok(AvVerdict::Clean);
    }
    if let Some(sig) = body.strip_suffix(" FOUND") {
        let sig: String = sig.trim().chars().filter(|c| !c.is_control()).take(120).collect();
        return Ok(AvVerdict::Infected(sig));
    }
    let shown: String = body.chars().filter(|c| !c.is_control()).take(120).collect();
    Err(AvError(format!("clamd: {shown}")))
}

#[async_trait]
impl AntiVirus for Clamd {
    fn engine(&self) -> &'static str {
        "clamav"
    }

    async fn scan(&self, bytes: &[u8]) -> Result<AvVerdict, AvError> {
        parse_reply(&self.talk(b"zINSTREAM\0", Some(bytes)).await?)
    }

    async fn version(&self) -> Option<String> {
        self.talk(b"zVERSION\0", None)
            .await
            .ok()
            .filter(|v| !v.is_empty())
    }
}
