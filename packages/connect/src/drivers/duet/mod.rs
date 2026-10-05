// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Duet boards running RepRapFirmware 3 in standalone mode, over the `rr_` HTTP endpoints.
//! DuetWebServer on single board computer setups answers the same endpoints.
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;
use reqwest::{Client, RequestBuilder};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::gate::{Action, ApprovalGate, ApprovalToken, params};
use crate::http::{self, base_url, f64_at, str_at};
use crate::manifest::{PluginManifest, manifest};
use crate::poll::poll_events;
use crate::types::{
    Capabilities, Capability, DiscoveredPrinter, Image, JobFile, PrinterConfig, PrinterEvent, PrinterState,
    PrinterStatus, RemoteFile, Secrets, StartOptions, Temp, now_iso, secs,
};
use crate::{PrinterConnector, PrinterSession};

pub struct DuetConnector {
    gate: Arc<dyn ApprovalGate>,
}

impl DuetConnector {
    pub fn new(gate: Arc<dyn ApprovalGate>) -> Self {
        Self { gate }
    }
}

#[async_trait]
impl PrinterConnector for DuetConnector {
    fn manifest(&self) -> PluginManifest {
        manifest("duet").unwrap_or_else(|| super::prusalink::unreachable_manifest("duet"))
    }

    /// Duet boards answer mDNS as `<hostname>.local`; the user enters the host.
    async fn discover(&self, _timeout: Duration) -> Vec<DiscoveredPrinter> {
        Vec::new()
    }

    async fn connect(&self, cfg: &PrinterConfig, secrets: &dyn Secrets) -> Result<Box<dyn PrinterSession>> {
        // Boards without a password accept the firmware default, "reprap".
        let password = cfg
            .credential_ref
            .as_deref()
            .and_then(|r| secrets.get(r))
            .unwrap_or_else(|| "reprap".to_owned());
        let inner = Arc::new(Inner {
            cfg: cfg.clone(),
            client: http::client(cfg)?,
            base: base_url(cfg, 80),
            password,
            gate: self.gate.clone(),
        });
        inner.connect().await?;
        Ok(Box::new(DuetSession { inner }))
    }
}

struct Inner {
    cfg: PrinterConfig,
    client: Client,
    base: String,
    password: String,
    gate: Arc<dyn ApprovalGate>,
}

impl Inner {
    fn id(&self) -> &str {
        &self.cfg.id
    }

    fn get(&self, path: &str) -> RequestBuilder {
        self.client.get(format!("{}{path}", self.base))
    }

    async fn connect(&self) -> Result<()> {
        let resp = http::send(
            self.id(),
            self.get("/rr_connect")
                .query(&[("password", self.password.as_str())]),
        )
        .await?;
        let v = http::json(self.id(), resp).await?;
        match v.get("err").and_then(Value::as_i64) {
            Some(0) => Ok(()),
            Some(1) => Err(Error::Auth {
                printer: self.id().to_owned(),
            }),
            Some(n) => Err(Error::protocol(self.id(), format!("rr_connect error {n}"))),
            None => Err(Error::protocol(self.id(), "unexpected rr_connect reply")),
        }
    }

    async fn model(&self) -> Result<Value> {
        let resp = http::send(self.id(), self.get("/rr_model").query(&[("flags", "d99vn")])).await?;
        let v = http::json(self.id(), resp).await?;
        v.get("result")
            .cloned()
            .ok_or_else(|| Error::protocol(self.id(), "rr_model without result"))
    }

    async fn gcode(&self, line: &str) -> Result<()> {
        let resp = http::send(self.id(), self.get("/rr_gcode").query(&[("gcode", line)])).await?;
        http::json(self.id(), resp).await.map(|_| ())
    }

    async fn fetch_status(&self) -> Result<PrinterStatus> {
        Ok(parse_status(self.id(), &self.model().await?))
    }
}

/// The absolute path of a file in the G-code folder: `0:/gcodes/<path>`. Takes the path the upload
/// returned (already under `0:/gcodes/`) or one relative to that folder. A drive prefix anywhere else,
/// `..`, quotes and control characters are refused, so `M32` never runs a system file or a macro.
pub(crate) fn gcodes_path(path: &str) -> Option<String> {
    let rel = path.strip_prefix("0:/gcodes/").unwrap_or(path);
    let ok = !rel.is_empty()
        && !rel.starts_with('/')
        && rel.split('/').all(|p| !p.is_empty() && p != "." && p != "..")
        && !rel
            .chars()
            .any(|c| matches!(c, ':' | '"' | '\\' | ';') || c.is_control());
    ok.then(|| format!("0:/gcodes/{rel}"))
}

/// RepRapFirmware runs several commands written on one line (`G1 X10 M104 S200`). A card shows one
/// command, so a second one is refused: a `G` or `M` word with a number after the first command, or
/// a `T` word after a `G` command (an `M` command takes `T` as its tool parameter). Quoted text and a
/// trailing comment are not read as commands.
pub(crate) fn second_command(line: &str) -> Option<&'static str> {
    let b = line.trim_start().as_bytes();
    let is_cmd = |i: usize| {
        b.get(i)
            .is_some_and(|c| matches!(c.to_ascii_uppercase(), b'G' | b'M' | b'T'))
            && b.get(i + 1).is_some_and(u8::is_ascii_digit)
    };
    // Meta commands (`echo`, `set`, `if`) and line numbers are refused outright.
    if !is_cmd(0) {
        return Some("a G-code line starts with one G, M or T command");
    }
    let first = b.first().map(u8::to_ascii_uppercase);
    let (mut quoted, mut braces) = (false, 0_u32);
    for i in 1..b.len() {
        let c = b.get(i).copied().unwrap_or(b' ');
        match c {
            b'"' => quoted = !quoted,
            b'{' if !quoted => braces = braces.saturating_add(1),
            b'}' if !quoted => braces = braces.saturating_sub(1),
            b';' if !quoted && braces == 0 => break,
            _ => {}
        }
        if quoted || braces > 0 || !is_cmd(i) {
            continue;
        }
        // A command word starts a field: after a space or right after a number (`G1X10G1Y5`).
        let prev = b.get(i - 1).copied().unwrap_or(b' ');
        if !(prev.is_ascii_whitespace() || prev.is_ascii_digit() || prev == b'.') {
            continue;
        }
        let letter = c.to_ascii_uppercase();
        if letter == b'T' && first == Some(b'M') {
            continue;
        }
        return Some("one G-code command per line: RepRapFirmware would run the second command too");
    }
    None
}

/// The object model's `move.axes`: each axis's letter, whether it is homed, where it is
/// (`userPosition`) and its `min` and `max`.
pub(crate) fn parse_motion(m: &Value) -> crate::Motion {
    let axes: Vec<&Value> = m
        .get("move")
        .and_then(|v| v.get("axes"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .collect();
    let by_letter = |l: &str| {
        axes.iter()
            .find(|a| a.get("letter").and_then(Value::as_str) == Some(l))
            .copied()
    };
    let [x, y, z] = [by_letter("X"), by_letter("Y"), by_letter("Z")];
    let all = |k: &str| -> Option<[f64; 3]> {
        Some([x?.get(k)?.as_f64()?, y?.get(k)?.as_f64()?, z?.get(k)?.as_f64()?])
    };
    let homed = (|| {
        Some([
            x?.get("homed")?.as_bool()?,
            y?.get("homed")?.as_bool()?,
            z?.get("homed")?.as_bool()?,
        ])
    })();
    crate::Motion {
        homed,
        position: all("userPosition"),
        min: all("min"),
        max: all("max"),
    }
}

pub(crate) fn parse_status(id: &str, m: &Value) -> PrinterStatus {
    let raw = str_at(m, &["state", "status"]).unwrap_or("idle");
    let state = match raw {
        "processing" | "simulating" | "resuming" => PrinterState::Printing,
        "pausing" | "paused" => PrinterState::Paused,
        "halted" => PrinterState::Error,
        "off" | "disconnected" => PrinterState::Offline,
        "starting" | "updating" => PrinterState::Preparing,
        _ => PrinterState::Idle,
    };
    let file = str_at(m, &["job", "file", "fileName"]).filter(|s| !s.is_empty());
    let last = str_at(m, &["job", "lastFileName"]).filter(|s| !s.is_empty());
    let size = f64_at(m, &["job", "file", "size"]);
    let pos = f64_at(m, &["job", "filePosition"]);
    let progress = match (pos, size) {
        (Some(p), Some(s)) if s > 0.0 => Some((p / s).clamp(0.0, 1.0)),
        _ => None,
    };
    let heaters = m
        .get("heat")
        .and_then(|h| h.get("heaters"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let heater = |idx: u64| -> Option<Temp> {
        let h = heaters.get(usize::try_from(idx).ok()?)?;
        Some(Temp {
            current: h.get("current")?.as_f64()?,
            target: h.get("active").and_then(Value::as_f64).unwrap_or(0.0),
        })
    };
    let first_of = |key: &str| {
        m.get("heat")
            .and_then(|h| h.get(key))
            .and_then(Value::as_array)
            .and_then(|a| a.iter().find_map(Value::as_u64))
    };
    let mut nozzles = Vec::new();
    for tool in m.get("tools").and_then(Value::as_array).into_iter().flatten() {
        if let Some(t) = tool
            .get("heaters")
            .and_then(Value::as_array)
            .and_then(|h| h.first())
            .and_then(Value::as_u64)
            .and_then(heater)
        {
            nozzles.push(t);
        }
    }
    PrinterStatus {
        printer_id: id.to_owned(),
        state,
        job_name: file
            .or(if state == PrinterState::Idle { None } else { last })
            .map(str::to_owned),
        progress: if file.is_some() { progress } else { None },
        layer: m
            .get("job")
            .and_then(|j| j.get("layer"))
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .filter(|_| file.is_some()),
        layer_count: m
            .get("job")
            .and_then(|j| j.get("file"))
            .and_then(|f| f.get("numLayers"))
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .filter(|_| file.is_some()),
        time_left_s: f64_at(m, &["job", "timesLeft", "file"])
            .filter(|_| file.is_some())
            .map(secs),
        nozzles,
        bed: first_of("bedHeaters").and_then(heater),
        chamber: first_of("chamberHeaters").and_then(heater),
        slots: Vec::new(),
        camera_available: false,
        message: None,
        updated_at: now_iso(),
        live: None,
    }
}

pub struct DuetSession {
    inner: Arc<Inner>,
}

#[async_trait]
impl PrinterSession for DuetSession {
    fn capabilities(&self) -> Capabilities {
        vec![
            Capability::Status,
            Capability::Events,
            Capability::Upload,
            Capability::Start,
            Capability::Pause,
            Capability::Resume,
            Capability::Cancel,
            Capability::GcodeConsole,
        ]
    }

    async fn status(&self) -> Result<PrinterStatus> {
        self.inner.fetch_status().await
    }

    fn events(&self) -> BoxStream<'static, PrinterEvent> {
        let inner = self.inner.clone();
        let interval = inner.cfg.poll_interval();
        let id = inner.cfg.id.clone();
        poll_events(
            id,
            interval,
            Arc::new(move || {
                let inner = inner.clone();
                async move { inner.fetch_status().await }
            }),
        )
    }

    async fn upload(&self, file: JobFile, token: &ApprovalToken) -> Result<RemoteFile> {
        self.inner.gate.check(
            token,
            Action::Upload,
            self.inner.id(),
            &params::upload(self.inner.id(), &file.name, &file.sha256),
        )?;
        if file.name.contains(['/', '\\', '"']) {
            return Err(Error::protocol(self.inner.id(), "unsafe file name"));
        }
        let path = format!("0:/gcodes/{}", file.name);
        let rb = self
            .inner
            .client
            .post(format!("{}/rr_upload", self.inner.base))
            .query(&[("name", path.as_str())])
            .body(file.data.clone());
        let resp = http::send(self.inner.id(), rb).await?;
        let v = http::json(self.inner.id(), resp).await?;
        if v.get("err").and_then(Value::as_i64) != Some(0) {
            return Err(Error::protocol(self.inner.id(), "rr_upload failed"));
        }
        Ok(RemoteFile {
            printer_id: self.inner.id().to_owned(),
            path,
            name: file.name,
            sha256: Some(file.sha256),
        })
    }

    async fn start(&self, file: &RemoteFile, opts: StartOptions, token: &ApprovalToken) -> Result<()> {
        opts.refuse_slot_map("duet")?;
        self.inner.gate.check(
            token,
            Action::Start,
            self.inner.id(),
            &params::start(self.inner.id(), file, &opts),
        )?;
        let path = gcodes_path(&file.path).ok_or_else(|| {
            Error::protocol(self.inner.id(), "the file is not in the printer's G-code folder")
        })?;
        // M32 selects the file and starts it.
        self.inner.gcode(&format!("M32 \"{path}\"")).await
    }

    async fn pause(&self, token: &ApprovalToken) -> Result<()> {
        self.inner.gate.check(
            token,
            Action::Pause,
            self.inner.id(),
            &params::printer(self.inner.id()),
        )?;
        self.inner.gcode("M25").await
    }

    async fn resume(&self, token: &ApprovalToken) -> Result<()> {
        self.inner.gate.check(
            token,
            Action::Resume,
            self.inner.id(),
            &params::printer(self.inner.id()),
        )?;
        self.inner.gcode("M24").await
    }

    async fn cancel(&self, token: &ApprovalToken) -> Result<()> {
        self.inner.gate.check(
            token,
            Action::Cancel,
            self.inner.id(),
            &params::printer(self.inner.id()),
        )?;
        // M0 stops the job and runs cancel.g.
        self.inner.gcode("M0").await
    }

    async fn snapshot(&self) -> Result<Option<Image>> {
        Ok(None)
    }

    async fn motion(&self) -> Result<crate::Motion> {
        Ok(parse_motion(&self.inner.model().await?))
    }

    async fn send_gcode(&self, line: &str, token: &ApprovalToken) -> Result<()> {
        // One command per call: a card showed this line whole, and nothing may ride behind it.
        crate::gate::one_gcode_line(self.inner.id(), line)?;
        if let Some(why) = second_command(line) {
            return Err(Error::protocol(self.inner.id(), why));
        }
        self.inner.gate.check(
            token,
            Action::Gcode,
            self.inner.id(),
            &params::gcode(self.inner.id(), line),
        )?;
        self.inner.gcode(line).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn starts_only_files_in_the_gcode_folder() {
        assert_eq!(gcodes_path("lid.gcode").as_deref(), Some("0:/gcodes/lid.gcode"));
        assert_eq!(
            gcodes_path("0:/gcodes/parts/lid.gcode").as_deref(),
            Some("0:/gcodes/parts/lid.gcode")
        );
        for bad in [
            "0:/sys/config.g",
            "1:/x.gcode",
            "0:/macros/m.g",
            "../sys/config.g",
            "/sys/config.g",
            "a\"b.gcode",
            "0:/gcodes/../sys/config.g",
            "",
        ] {
            assert_eq!(gcodes_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_second_command_on_one_line_is_refused() {
        for ok in [
            "G1 X10 F3000",
            "G91",
            "M104 S200 T1",
            "M117 \"G1 inside a message\"",
            "G1 X{move.axes[0].max - 10}",
            "M106 P1 S255 ; fan M107",
            "T1",
        ] {
            assert_eq!(second_command(ok), None, "{ok}");
        }
        for bad in [
            "G1 X10 M104 S300",
            "G1X10G1Y20",
            "G1 X10 T1",
            "M104 S200 G28",
            "T1 M104 S300",
            "echo \"hi\"",
            "N10 G1 X1",
            "g1 x1 m112",
        ] {
            assert!(second_command(bad).is_some(), "{bad}");
        }
    }

    #[test]
    fn motion_reads_the_axes() {
        let m = json!({"move": {"axes": [
            {"letter": "X", "homed": true, "userPosition": 10.0, "min": 0.0, "max": 300.0},
            {"letter": "Y", "homed": true, "userPosition": 20.0, "min": 0.0, "max": 300.0},
            {"letter": "Z", "homed": false, "userPosition": 5.0, "min": 0.0, "max": 400.0}]}});
        let mo = parse_motion(&m);
        assert_eq!(mo.homed, Some([true, true, false]));
        assert_eq!(mo.position, Some([10.0, 20.0, 5.0]));
        assert_eq!(parse_motion(&json!({})), crate::Motion::default());
    }
}
