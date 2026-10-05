// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The local model: SigLIP2 base (google/siglip2-base-patch16-224, Apache-2.0 weights) asked
//! zero-shot which of four descriptions fits the bed area: spaghetti, a blob on the nozzle, a
//! part knocked over, or a normal print. The prompts are folded into the model file by
//! `model/export_siglip2.py`, so only the image tower runs here, through ONNX Runtime.
//!
//! The model file (`sx-watch-siglip2.onnx`, 177 MB) is not in git. It sits beside the sx-watch
//! binary, or where `--model` or `SX_WATCH_MODEL` says.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use ort::session::Session;
use ort::value::Tensor;

use crate::decode::Rgb;
use crate::detector::{Detection, Detector};
use crate::protocol::Kind;
use crate::resize::resize;

/// The model file's name.
pub const MODEL_FILE: &str = "sx-watch-siglip2.onnx";
/// Input size the model was trained at.
pub const SIZE: usize = 224;
/// Order of the model's `probs` output (see `model/export_siglip2.py`).
const OUTPUTS: [Option<Kind>; 4] = [Some(Kind::Spaghetti), Some(Kind::NozzleBlob), None, None];

/// Where the model is looked for: `SX_WATCH_MODEL`, then beside the running binary.
pub fn default_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("SX_WATCH_MODEL") {
        return Some(PathBuf::from(p));
    }
    Some(std::env::current_exe().ok()?.parent()?.join(MODEL_FILE))
}

/// SigLIP2 on ONNX Runtime.
pub struct Siglip2 {
    session: Mutex<Session>,
}

impl std::fmt::Debug for Siglip2 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Siglip2")
    }
}

/// The picture as the model takes it: 224 by 224, RGB planes scaled to -1..1.
pub fn pixels(rgb: &Rgb) -> Vec<f32> {
    let small = resize(&rgb.data, rgb.width as usize, rgb.height as usize, 3, SIZE, SIZE);
    let mut out = vec![0f32; 3 * SIZE * SIZE];
    for (i, px) in small.as_chunks::<3>().0.iter().enumerate() {
        for (c, &v) in px.iter().enumerate() {
            if let Some(o) = out.get_mut(c * SIZE * SIZE + i) {
                *o = f32::from(v) / 127.5 - 1.0;
            }
        }
    }
    out
}

impl Siglip2 {
    /// Loads the model, running on `threads` CPU threads (one is enough at one frame per 10 s).
    pub fn load(path: &Path, threads: usize) -> Result<Self, String> {
        let mut builder = Session::builder()
            .map_err(|e| e.to_string())?
            .with_intra_threads(threads.max(1))
            .map_err(|e| e.to_string())?;
        let session = builder
            .commit_from_file(path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(Self {
            session: Mutex::new(session),
        })
    }

    /// The four probabilities for a picture: spaghetti, nozzle blob, knocked over, normal.
    pub fn probs(&self, rgb: &Rgb) -> Result<[f32; 4], String> {
        let input = Tensor::from_array(([1usize, 3, SIZE, SIZE], pixels(rgb))).map_err(|e| e.to_string())?;
        let mut session = self
            .session
            .lock()
            .map_err(|_| "the model is poisoned".to_owned())?;
        let outputs = session
            .run(ort::inputs!["pixel_values" => input])
            .map_err(|e| e.to_string())?;
        let probs = outputs.get("probs").ok_or("the model has no probs output")?;
        let (_, data) = probs.try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let mut out = [0f32; 4];
        for (o, v) in out.iter_mut().zip(data) {
            *o = *v;
        }
        Ok(out)
    }
}

impl Detector for Siglip2 {
    fn name(&self) -> &'static str {
        "siglip2-base-224"
    }

    fn detect(&self, frame: &Rgb) -> Vec<Detection> {
        let Ok(probs) = self.probs(frame) else {
            return Vec::new();
        };
        OUTPUTS
            .iter()
            .zip(probs)
            .filter_map(|(kind, p)| {
                kind.map(|kind| Detection {
                    kind,
                    score: f64::from(p),
                    bbox: [0.0, 0.0, 1.0, 1.0],
                })
            })
            .collect()
    }

    fn whole_image(&self) -> bool {
        true
    }
}
