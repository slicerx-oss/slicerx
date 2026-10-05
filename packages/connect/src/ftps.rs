// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A small implicit-TLS FTP client that stores a file and lists a folder. Bambu Lab printers
//! serve FTPS on port 990 with the user `bblp` and the LAN access code.
use std::time::Duration;

use rustls::pki_types::ServerName;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

use crate::error::{Error, Result};
use crate::tls::bambu_lan_config;

pub(crate) struct FtpsTarget<'a> {
    pub printer: &'a str,
    pub host: &'a str,
    pub port: u16,
    pub user: &'a str,
    pub password: &'a str,
}

pub(crate) async fn store(t: &FtpsTarget<'_>, name: &str, data: &[u8]) -> Result<()> {
    // The whole exchange gets a deadline so a stalled printer cannot hang the caller.
    let secs = 30 + u64::try_from(data.len() / 500_000).unwrap_or(0);
    tokio::time::timeout(Duration::from_secs(secs), run(t, name, data))
        .await
        .map_err(|_| Error::unreachable(t.printer, "FTPS upload timed out"))?
}

type Ctl = (
    BufReader<tokio::io::ReadHalf<tokio_rustls::client::TlsStream<TcpStream>>>,
    tokio::io::WriteHalf<tokio_rustls::client::TlsStream<TcpStream>>,
    TlsConnector,
    ServerName<'static>,
);

/// Lists `dir` (`""` for the root). Unix-style `LIST` lines, as the printer sends them; at most
/// 2 MB of listing is read.
pub(crate) async fn list(t: &FtpsTarget<'_>, dir: &str) -> Result<Vec<Entry>> {
    tokio::time::timeout(Duration::from_secs(20), list_run(t, dir))
        .await
        .map_err(|_| Error::unreachable(t.printer, "FTPS listing timed out"))?
}

async fn list_run(t: &FtpsTarget<'_>, dir: &str) -> Result<Vec<Entry>> {
    use tokio::io::AsyncReadExt;
    if dir.contains(['\r', '\n']) {
        return Err(Error::protocol(t.printer, "unsafe folder name"));
    }
    let (mut rd, mut wr, connector, server_name) = login(t).await?;
    let port = passive(t, &mut rd, &mut wr).await?;
    let dtcp = TcpStream::connect((t.host, port))
        .await
        .map_err(|e| Error::unreachable(t.printer, e))?;
    send(
        t,
        &mut wr,
        &if dir.is_empty() {
            "LIST".to_owned()
        } else {
            format!("LIST /{dir}")
        },
    )
    .await?;
    let code = reply(t, &mut rd).await?;
    if code == 550 || code == 450 {
        // No such folder: nothing in it.
        let _ = send(t, &mut wr, "QUIT").await;
        return Ok(Vec::new());
    }
    if code != 150 && code != 125 {
        return Err(Error::protocol(t.printer, format!("FTP {code} after LIST")));
    }
    let dtls = connector
        .connect(server_name, dtcp)
        .await
        .map_err(|e| Error::unreachable(t.printer, e))?;
    let mut raw = Vec::new();
    // Printers often close the data connection without a TLS close_notify; the 226 reply on the
    // control connection is what says the listing is complete.
    match dtls.take(2 * 1024 * 1024).read_to_end(&mut raw).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {}
        Err(e) => return Err(Error::unreachable(t.printer, e)),
    }
    expect(t, &mut rd, 226).await?;
    let _ = send(t, &mut wr, "QUIT").await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    Ok(String::from_utf8_lossy(&raw)
        .lines()
        .filter_map(|l| parse_list_line(l, now))
        .collect())
}

/// One entry of a folder listing. `modified` is seconds since the epoch, to the minute.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Entry {
    pub name: String,
    pub dir: bool,
    pub size: u64,
    pub modified: Option<f64>,
}

/// Parses `-rw-r--r-- 1 root root 12345 Oct 01 12:00 name` (the time, or the year for files older
/// than six months). `now` (seconds since the epoch) picks the year when the line has a time.
pub(crate) fn parse_list_line(line: &str, now: u64) -> Option<Entry> {
    let mut it = line.split_whitespace();
    let perms = it.next()?;
    let kind = perms.chars().next()?;
    if !matches!(kind, '-' | 'd') {
        return None;
    }
    let _links = it.next()?;
    let _user = it.next()?;
    let _group = it.next()?;
    let size: u64 = it.next()?.parse().ok()?;
    let month = it.next()?;
    let day: u64 = it.next()?.parse().ok()?;
    let time_or_year = it.next()?;
    // The name is the rest of the line after the eighth field, spaces included.
    let mut rest = line;
    for _ in 0..8 {
        rest = rest.trim_start();
        rest = rest.get(rest.find(char::is_whitespace)?..)?;
    }
    let name = rest.trim_start().to_owned();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let m = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|x| x.eq_ignore_ascii_case(month))
    .map(|i| i as u64 + 1);
    let modified = m.and_then(|m| {
        let (year, hh, mm) = match time_or_year.split_once(':') {
            Some((h, mi)) => {
                let (h, mi): (u64, u64) = (h.parse().ok()?, mi.parse().ok()?);
                let this = civil_year(now);
                // A time means the last six months: a date ahead of now is last year's.
                let y = if days_from_civil(this, m, day) * 86_400 > now + 86_400 {
                    this - 1
                } else {
                    this
                };
                (y, h, mi)
            }
            None => (time_or_year.parse().ok()?, 0, 0),
        };
        let secs = days_from_civil(year, m, day) * 86_400 + hh * 3600 + mm * 60;
        u32::try_from(secs).ok().map(f64::from)
    });
    Some(Entry {
        name,
        dir: kind == 'd',
        size,
        modified,
    })
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
fn days_from_civil(y: u64, m: u64, d: u64) -> u64 {
    let y = if m <= 2 { y.saturating_sub(1) } else { y };
    let era = y / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d.saturating_sub(1);
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146_097 + doe).saturating_sub(719_468)
}

/// The year of a time in seconds since the epoch.
fn civil_year(secs: u64) -> u64 {
    let mut y = 1970 + secs / 31_556_952;
    while days_from_civil(y, 1, 1) * 86_400 > secs {
        y -= 1;
    }
    while days_from_civil(y + 1, 1, 1) * 86_400 <= secs {
        y += 1;
    }
    y
}

/// Connects and logs in, with the data channel protected.
async fn login(t: &FtpsTarget<'_>) -> Result<Ctl> {
    let connector = TlsConnector::from(bambu_lan_config()?);
    let server_name =
        ServerName::try_from(t.host.to_owned()).map_err(|_| Error::Config("bad host".to_owned()))?;
    let tcp = TcpStream::connect((t.host, t.port))
        .await
        .map_err(|e| Error::unreachable(t.printer, e))?;
    let tls = connector
        .connect(server_name.clone(), tcp)
        .await
        .map_err(|e| Error::unreachable(t.printer, e))?;
    let (rd, mut wr) = tokio::io::split(tls);
    let mut rd = BufReader::new(rd);

    expect(t, &mut rd, 220).await?;
    send(t, &mut wr, &format!("USER {}", t.user)).await?;
    let code = reply(t, &mut rd).await?;
    if code == 331 {
        send(t, &mut wr, &format!("PASS {}", t.password)).await?;
        let code = reply(t, &mut rd).await?;
        if code == 530 {
            return Err(Error::Auth {
                printer: t.printer.to_owned(),
            });
        }
        if code != 230 {
            return Err(Error::protocol(t.printer, format!("FTP {code} after PASS")));
        }
    } else if code != 230 {
        return Err(Error::protocol(t.printer, format!("FTP {code} after USER")));
    }
    for cmd in ["PBSZ 0", "PROT P", "TYPE I"] {
        send(t, &mut wr, cmd).await?;
        expect(t, &mut rd, 200).await?;
    }
    Ok((rd, wr, connector, server_name))
}

async fn passive<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    t: &FtpsTarget<'_>,
    rd: &mut BufReader<R>,
    wr: &mut W,
) -> Result<u16> {
    send(t, wr, "PASV").await?;
    let (code, text) = reply_text(t, rd).await?;
    if code != 227 {
        return Err(Error::protocol(t.printer, format!("FTP {code} after PASV")));
    }
    pasv_port(&text).ok_or_else(|| Error::protocol(t.printer, "bad PASV reply"))
}

async fn run(t: &FtpsTarget<'_>, name: &str, data: &[u8]) -> Result<()> {
    if name.contains(['\r', '\n', '/']) || name.is_empty() {
        return Err(Error::protocol(t.printer, "unsafe file name"));
    }
    let (mut rd, mut wr, connector, server_name) = login(t).await?;
    let port = passive(t, &mut rd, &mut wr).await?;

    // The printer may report an unroutable address, so the data connection goes to the
    // host the control connection used.
    let dtcp = TcpStream::connect((t.host, port))
        .await
        .map_err(|e| Error::unreachable(t.printer, e))?;
    send(t, &mut wr, &format!("STOR {name}")).await?;
    let mut dtls = connector
        .connect(server_name, dtcp)
        .await
        .map_err(|e| Error::unreachable(t.printer, e))?;
    let code = reply(t, &mut rd).await?;
    if code != 150 && code != 125 {
        return Err(Error::protocol(t.printer, format!("FTP {code} after STOR")));
    }
    dtls.write_all(data)
        .await
        .map_err(|e| Error::unreachable(t.printer, e))?;
    dtls.shutdown()
        .await
        .map_err(|e| Error::unreachable(t.printer, e))?;
    // Read what the server still sends (TLS 1.3 session tickets, its close_notify) until it closes. A
    // socket closed with unread data is reset, and on Windows the reset can reach the server before
    // the upload's end does, so it never answers 226. A server that just closes ends the read too.
    let mut rest = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), dtls.read_to_end(&mut rest)).await;
    drop(dtls);
    expect(t, &mut rd, 226).await?;
    let _ = send(t, &mut wr, "QUIT").await;
    Ok(())
}

async fn send<W: AsyncWrite + Unpin>(t: &FtpsTarget<'_>, wr: &mut W, line: &str) -> Result<()> {
    wr.write_all(format!("{line}\r\n").as_bytes())
        .await
        .map_err(|e| Error::unreachable(t.printer, e))?;
    wr.flush().await.map_err(|e| Error::unreachable(t.printer, e))
}

async fn expect<R: AsyncRead + Unpin>(t: &FtpsTarget<'_>, rd: &mut BufReader<R>, want: u16) -> Result<()> {
    let got = reply(t, rd).await?;
    if got == want {
        Ok(())
    } else {
        Err(Error::protocol(t.printer, format!("FTP {got}, expected {want}")))
    }
}

async fn reply<R: AsyncRead + Unpin>(t: &FtpsTarget<'_>, rd: &mut BufReader<R>) -> Result<u16> {
    Ok(reply_text(t, rd).await?.0)
}

/// Reads one reply, joining multi-line replies (`123-` ... `123 `).
async fn reply_text<R: AsyncRead + Unpin>(
    t: &FtpsTarget<'_>,
    rd: &mut BufReader<R>,
) -> Result<(u16, String)> {
    let mut full = String::new();
    loop {
        let mut line = String::new();
        let n = rd
            .read_line(&mut line)
            .await
            .map_err(|e| Error::unreachable(t.printer, e))?;
        if n == 0 {
            return Err(Error::unreachable(t.printer, "FTP control connection closed"));
        }
        let code: Option<u16> = line.get(..3).and_then(|c| c.parse().ok());
        let last = line.get(3..4) == Some(" ");
        full.push_str(&line);
        if let (Some(code), true) = (code, last) {
            return Ok((code, full));
        }
    }
}

/// Parses `227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)`.
pub(crate) fn pasv_port(text: &str) -> Option<u16> {
    let inner = text.split('(').nth(1)?.split(')').next()?;
    let nums: Vec<u16> = inner.split(',').filter_map(|n| n.trim().parse().ok()).collect();
    match nums.as_slice() {
        [_, _, _, _, hi, lo] => Some(hi.checked_mul(256)?.checked_add(*lo)?),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn list_lines() {
        // 2026-10-02 12:00 UTC.
        let now = 1_790_942_400;
        let e = super::parse_list_line(
            "-rw-rw-rw- 1 root root 1048576 Oct 01 09:30 lid v2.gcode.3mf",
            now,
        )
        .unwrap();
        assert_eq!(e.name, "lid v2.gcode.3mf");
        assert_eq!(e.size, 1_048_576);
        assert!(!e.dir);
        assert_eq!(e.modified, Some(1_790_847_000.0));
        let old = super::parse_list_line("-rw-rw-rw- 1 root root 10 Dec 24 2025 old.3mf", now).unwrap();
        assert_eq!(old.modified, Some(1_766_534_400.0));
        // A time later in the year than today is last year's.
        let last = super::parse_list_line("-rw-rw-rw- 1 root root 10 Dec 24 08:00 x.3mf", now).unwrap();
        assert_eq!(last.modified, Some(1_766_563_200.0));
        assert!(
            super::parse_list_line("drwxrwxrwx 1 root root 0 Oct 01 09:30 cache", now)
                .unwrap()
                .dir
        );
        assert!(super::parse_list_line("total 12", now).is_none());
        assert!(super::parse_list_line("lrwxrwxrwx 1 root root 3 Oct 01 09:30 a -> b", now).is_none());
    }

    #[test]
    fn pasv() {
        assert_eq!(
            super::pasv_port("227 Entering Passive Mode (192,0,2,11,7,208)."),
            Some(2000)
        );
        assert_eq!(super::pasv_port("227 nope"), None);
    }
}
