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
    /// A person's hand inside the printer while it prints. A safety stop, not a failure: the
    /// hub pauses on it without waiting for confirmation (see [`crate::policy`]).
    Hand,
}

impl Kind {
    /// Every kind, in report order. A hand comes first: it is the one that pauses at once.
    pub const ALL: [Kind; 3] = [Kind::Hand, Kind::Spaghetti, Kind::NozzleBlob];

    /// The wire name.
    pub fn name(self) -> &'static str {
        match self {
            Kind::Spaghetti => "spaghetti",
            Kind::NozzleBlob => "nozzle_blob",
            Kind::Hand => "hand",
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
    /// Where in the frame, left, top, right, bottom from 0 to 1, when the watch could tell
    /// (for a hand: the part of the bed area that changed since the frame before).
    #[serde(rename = "box", skip_serializing_if = "Option::is_none")]
    pub bbox: Option<[f64; 4]>,
}

/// A picture as the hub sends it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Picture {
    /// `image/jpeg`, `image/png` or `image/webp`.
    pub content_type: String,
    /// The picture.
    pub data_base64: String,
}

/// `watch.plate` data: the plate before a print, to compare with the person's empty-plate
/// picture.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlateCheck {
    /// Echoed in the result.
    pub check_id: String,
    /// The printer.
    pub printer_id: String,
    /// The plate now.
    pub frame: Picture,
    /// The plate as the person said it was clear, when they captured one.
    #[serde(default)]
    pub reference: Option<Picture>,
    /// Spots the person said are fine (plate marks), left, top, right, bottom from 0 to 1.
    #[serde(default)]
    pub ignore: Vec<[f64; 4]>,
}

/// `watch.plateResult` parameters.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlateResult {
    /// From the check.
    pub check_id: String,
    /// The printer.
    pub printer_id: String,
    /// True when nothing was found; `None` when the plate could not be judged (no usable
    /// picture), which never blocks a start.
    pub clear: Option<bool>,
    /// The spot that differs most from the empty plate, left, top, right, bottom from 0 to 1.
    #[serde(rename = "box", skip_serializing_if = "Option::is_none")]
    pub bbox: Option<[f64; 4]>,
    /// The model's debris score for the plate now, 0 to 1, when the model has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debris: Option<f64>,
    /// What was compared and why, for the app.
    pub note: String,
}
