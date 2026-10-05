// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-watch: the print watch's failure detector, a client of sx-link with the `watch` role.
//!
//! The hub sends a still of each printing printer every 10 seconds (`watch.frame`). For each
//! frame this crate decodes the picture, skips it when it is too dark, too bright or blurred,
//! runs the detector, keeps only findings inside the printer's bed mask, and reports
//! (`watch.report`) only when 3 of the last 5 usable frames agree. It stays quiet on the first
//! layer and for 30 seconds after a print starts or resumes, and a person's "this is fine"
//! (`watch.dismissed`) raises that printer's threshold for the rest of the print.
//!
//! The detector is SigLIP2 run locally ([`siglip`]), scored against each print's own start
//! together with the bed area's frame change ([`change`], [`policy::Relative`]). When the
//! person turned it on for a printer, huginn confirms one frame before the report goes out
//! ([`confirm`]); only a confirmed finding can auto-pause. Without the model file the watch
//! runs [`detector::Stub`], which finds nothing.
//!
//! [`session::Session`] holds that logic behind plain JSON in and out, so it runs and is tested
//! without a network connection.
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]

pub mod change;
pub mod client;
pub mod confirm;
pub mod decode;
pub mod detector;
pub mod mask;
pub mod policy;
pub mod protocol;
pub mod quality;
pub mod resize;
pub mod session;
#[cfg(feature = "siglip")]
pub mod siglip;
