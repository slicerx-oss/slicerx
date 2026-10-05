// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-connect. See README.md for the public API.
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]
// Product names (OctoPrint, PrusaLink, RepRapFirmware) are prose here, not code.
#![allow(clippy::doc_markdown)]

pub mod camera;
mod digest;
mod error;
mod ftps;
mod gate;
mod http;
mod manifest;
pub mod onvif;
mod poll;
mod push;
mod rtsp;
mod secrets;
mod tls;
mod trace;
mod types;
mod wslink;

pub mod drivers;
pub mod mdns;
pub mod netif;
pub mod services;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;

pub use error::{Error, ErrorCode, LoginNeed, Result};
pub use gate::{Action, ApprovalGate, ApprovalToken, MAX_GCODE_LINE, MemoryGate, gcode_line_problem, params};
pub use manifest::{PermissionClass, PluginKind, PluginManifest, ToolSpec, all_manifests, manifest};
pub use secrets::{
    FileSecrets, KeychainSecrets, MemorySecrets, SecretStore, create_private_dir, write_private,
};
pub use tls::{CertificateCheck, certificate_check};
pub use trace::trace;
pub use types::{
    Adjustment, Capabilities, Capability, DiscoveredPrinter, ExtruderInfo, FanKind, Fans, FilamentSlot,
    FilamentUnit, FileInfo, Image, JobFile, JobKind, JogAxis, LiveUnit, Motion, PrintObject, PrintRecord,
    PrinterConfig, PrinterEvent, PrinterHardware, PrinterIssue, PrinterLive, PrinterState, PrinterStatus,
    RemoteFile, Secrets, SlotSetting, StartOptions, StoredFile, Temp,
};

/// One printer family. `connect` opens a session; nothing here changes a printer.
#[async_trait]
pub trait PrinterConnector: Send + Sync {
    fn manifest(&self) -> PluginManifest;
    /// Passive discovery only (listening for announcements). Never probes addresses.
    async fn discover(&self, timeout: Duration) -> Vec<DiscoveredPrinter>;
    /// Asks one address whether a printer of this family is there, without signing in. `None` when
    /// nothing answered or the family has no way to ask.
    async fn probe(&self, _host: &str, _timeout: Duration) -> Option<DiscoveredPrinter> {
        None
    }
    async fn connect(&self, cfg: &PrinterConfig, secrets: &dyn Secrets) -> Result<Box<dyn PrinterSession>>;

    /// Pairing step for printers that ask for confirmation on their own screen (Snapmaker 2.0).
    /// Returns the credential to store in the keychain under the printer's `credential_ref`, or
    /// `None` when the printer needs no pairing. `timeout` bounds the wait for the tap.
    async fn authorize(&self, _cfg: &PrinterConfig, _timeout: Duration) -> Result<Option<String>> {
        Ok(None)
    }
}

/// A live connection to one printer. Every call with a side effect takes an approval token
/// and checks it through the connector's [`ApprovalGate`] before anything is sent.
#[async_trait]
pub trait PrinterSession: Send + Sync {
    fn capabilities(&self) -> Capabilities;
    async fn status(&self) -> Result<PrinterStatus>;
    fn events(&self) -> BoxStream<'static, PrinterEvent>;
    async fn upload(&self, file: JobFile, token: &ApprovalToken) -> Result<RemoteFile>;
    async fn start(&self, file: &RemoteFile, opts: StartOptions, token: &ApprovalToken) -> Result<()>;
    async fn pause(&self, token: &ApprovalToken) -> Result<()>;
    async fn resume(&self, token: &ApprovalToken) -> Result<()>;
    async fn cancel(&self, token: &ApprovalToken) -> Result<()>;
    async fn snapshot(&self) -> Result<Option<Image>>;
    /// The live camera at the camera's native quality, or `None` when the printer has no camera
    /// this connector can read. Dropping the stream closes the connection to the camera.
    async fn stream(&self) -> Result<Option<camera::FrameStream>> {
        Ok(None)
    }
    /// Passes a browser's WebRTC offer to the printer's camera service and returns its answer SDP.
    /// `None` when the camera has no WebRTC service. Media then flows between the browser and the
    /// camera directly; only the signaling goes through here.
    async fn webrtc_offer(&self, _offer_sdp: &str) -> Result<Option<String>> {
        Ok(None)
    }
    async fn send_gcode(&self, line: &str, token: &ApprovalToken) -> Result<()>;
    /// Size and modification time of a file on the printer, for printers that report them. The hub
    /// compares them with what it uploaded, so a file changed behind its back reads as unverified.
    async fn file_info(&self, _path: &str) -> Result<Option<FileInfo>> {
        Ok(None)
    }
    /// Changes a running print (fan, speed factor, temperatures) under an `adjust` token. The
    /// caller has already checked the value against the safe limits.
    async fn adjust(&self, _change: &Adjustment, _token: &ApprovalToken) -> Result<()> {
        Err(Error::not_supported("this printer", "changes during a print"))
    }
    /// Turns the chamber light on or off, under an `adjust` token over [`params::light`].
    async fn set_light(&self, _on: bool, _token: &ApprovalToken) -> Result<()> {
        Err(Error::not_supported("this printer", "switching its light"))
    }
    /// Writes what a filament slot holds to the printer (Bambu Lab AMS `ams_filament_setting`), under
    /// an `adjust` token over [`params::slot`]. The caller has already checked the setting.
    async fn set_slot(&self, _setting: &SlotSetting, _token: &ApprovalToken) -> Result<()> {
        Err(Error::not_supported("this printer", "writing its filament slots"))
    }
    /// The G-code files stored on the printer, newest first. Read only.
    async fn list_files(&self) -> Result<Vec<StoredFile>> {
        Err(Error::not_supported("this printer", "listing its files"))
    }
    /// The printer's own print history, newest first. Read only.
    async fn history(&self) -> Result<Vec<PrintRecord>> {
        Err(Error::not_supported("this printer", "a print history"))
    }
    /// The objects of the running print, when the G-code labels them. Read only.
    async fn objects(&self) -> Result<Vec<PrintObject>> {
        Err(Error::not_supported("this printer", "skipping objects"))
    }
    /// Stops printing one object of the running print. `id` is a label from [`Self::objects`]. Takes
    /// a `printer.gcode` token over [`params::gcode`] of [`skip_object_line`], so the card shows
    /// the exact command.
    async fn skip_object(&self, _id: &str, _token: &ApprovalToken) -> Result<()> {
        Err(Error::not_supported("this printer", "skipping objects"))
    }
    /// What the printer reports as wrong, in plain words (Bambu HMS and print errors). Read only.
    async fn issues(&self) -> Result<Vec<PrinterIssue>> {
        Ok(Vec::new())
    }
    /// Head position, homed axes and axis limits, as far as the printer reports them. Jog checks
    /// its moves against this. The default knows nothing.
    async fn motion(&self) -> Result<Motion> {
        Ok(Motion::default())
    }
    /// True when a start shows in the status only seconds later (Bambu Lab reports the old state
    /// until the job is prepared), so the hub ignores readings of the last job for a short while.
    fn reports_start_late(&self) -> bool {
        false
    }
    /// How long the printer's own firmware keeps the heaters on in a paused print before it turns
    /// them off. `None` when the printer has no such timeout SlicerX can count on; the hub then
    /// notes on the paused print that its heaters stay on, and sends nothing by itself.
    fn pause_heater_timeout(&self) -> Option<std::time::Duration> {
        None
    }
    /// Object ids the printer itself reports as skipped in the running print, for printers that
    /// cannot list their objects but do report skips (Bambu Lab `s_obj`).
    async fn reported_skips(&self) -> Vec<String> {
        Vec::new()
    }
    /// The model, firmware, nozzles and filament units the printer reports. `None` when the family
    /// reports none of it.
    async fn hardware(&self) -> Result<Option<PrinterHardware>> {
        Ok(None)
    }
    /// The model the printer itself reports ("A1", "A1 mini"), for printers that say it. The hub adds
    /// it to the status as `model`, so a printer added by address alone still reads as what it is.
    fn reported_model(&self) -> Option<String> {
        None
    }
}

/// The line a skip card shows and the token binds to, so the card and the command cannot differ.
#[must_use]
pub fn skip_object_line(id: &str) -> String {
    format!("EXCLUDE_OBJECT NAME={id}")
}

/// Whether `id` is safe to carry in an `EXCLUDE_OBJECT` line: a label, never a second command.
#[must_use]
pub fn object_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// Spoolman and Home Assistant. `call` takes the tool name from the manifest (with or
/// without the `<id>.` prefix).
#[async_trait]
pub trait ServicePlugin: Send + Sync {
    fn manifest(&self) -> PluginManifest;
    async fn call(
        &self,
        tool: &str,
        args: serde_json::Value,
        token: Option<&ApprovalToken>,
    ) -> Result<serde_json::Value>;
}

/// Connectors that have not passed the real-printer check yet (packages/connect/docs/real-printer-checklist.md).
/// Hubs hide them unless the user turns on experimental connectors. Creality printers that run
/// Moonraker can use the `moonraker` connector instead.
pub const EXPERIMENTAL_PLUGINS: [&str; 4] = ["duet", "snapmaker", "creality", "home-assistant"];

/// Whether a plugin id is in [`EXPERIMENTAL_PLUGINS`].
pub fn is_experimental(plugin: &str) -> bool {
    EXPERIMENTAL_PLUGINS.contains(&plugin)
}

/// Every first-party printer connector, sharing one approval gate.
pub fn registry(gate: Arc<dyn ApprovalGate>) -> Vec<Box<dyn PrinterConnector>> {
    registry_with(gate, std::net::Ipv4Addr::UNSPECIFIED.into())
}

/// The connectors, with network discovery listening and sending on `discovery_bind`: every address in the
/// app, 127.0.0.1 in tests, so the OS firewall has nothing to ask.
pub fn registry_with(
    gate: Arc<dyn ApprovalGate>,
    discovery_bind: std::net::IpAddr,
) -> Vec<Box<dyn PrinterConnector>> {
    drivers::all(gate, discovery_bind)
}

/// Finds a connector by plugin id.
pub fn connector_for(gate: Arc<dyn ApprovalGate>, plugin: &str) -> Option<Box<dyn PrinterConnector>> {
    registry(gate).into_iter().find(|c| c.manifest().id == plugin)
}
