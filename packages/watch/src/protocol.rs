// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The sx-link messages the watch uses: `watch.frame` and `watch.dismissed` in, `watch.report`
//! out. Field names follow packages/connect/link/src/watch.rs.
use serde::{Deserialize, Serialize};

/// What a detector looks for. Wire names are the hub's `watch.report` kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Loose filament in the air: the print has come off or failed.
    Spaghetti,
    /// A lump of plastic stuck around the nozzle.
    NozzleBlob,
}

impl Kind {
    /// Every kind, in report order.
    pub const ALL: [Kind; 2] = [Kind::Spaghetti, Kind::NozzleBlob];

    /// The wire name.
    pub fn name(self) -> &'static str {
        match self {
            Kind::Spaghetti => "spaghetti",
            Kind::NozzleBlob => "nozzle_blob",
        }
    }
}

/// `watch.frame` data: one still of a printing printer.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    /// The printer.
    pub printer_id: String,
    /// `image/jpeg`, `image/png` or `image/webp`, sniffed by the hub.
    pub content_type: String,
    /// The picture.
    pub data_base64: String,
    /// When the camera took it (ISO 8601).
    pub captured_at: String,
    /// The printer's state as the hub saw it.
    #[serde(default)]
    pub state: Option<String>,
    /// Current layer, when the printer reports it.
    #[serde(default)]
    pub layer: Option<u32>,
    /// Layers in the job, when the printer reports it.
    #[serde(default)]
    pub layer_count: Option<u32>,
}

/// `watch.dismissed` data: a person said a finding was fine.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dismissed {
    /// The printer.
    pub printer_id: String,
    /// The kind the person dismissed.
    pub kind: Kind,
}

/// `watch.report` parameters.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// The printer.
    pub printer_id: String,
    /// What was seen.
    pub kind: Kind,
    /// 0 to 1: the mean suspicion (or score) of the agreeing frames.
    pub confidence: f64,
    /// How the decision was made, for the app and the log.
    pub note: String,
    /// huginn's answer on one frame, when the person turned confirmation on for this printer:
    /// true when it agreed the print failed. Absent when nobody was asked. The hub auto-pauses
    /// only on `true`; without it the finding notifies and nothing more.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed: Option<bool>,
}
