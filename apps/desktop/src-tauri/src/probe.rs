// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Startup and slicing probe for benchmarks and smoke tests. With SX_PROBE=1
//! the frontend slices the reference plate through the normal `slice` command
//! and reports here; the report goes to stdout as one `sx-probe` JSON line,
//! with the time since `main` started, and the app exits.
use std::sync::OnceLock;
use std::time::Instant;
use tauri::AppHandle;

static STARTED: OnceLock<Instant> = OnceLock::new();

pub fn mark_start() {
    let _ = STARTED.set(Instant::now());
}

#[tauri::command]
pub fn probe_enabled() -> bool {
    std::env::var("SX_PROBE").is_ok_and(|v| v == "1")
}

#[tauri::command]
pub fn probe_report(app: AppHandle, mut report: serde_json::Value) {
    let since_main_ms = STARTED.get().map_or(0.0, |t| t.elapsed().as_secs_f64() * 1000.0);
    if let Some(map) = report.as_object_mut() {
        map.insert("sinceMainMs".into(), since_main_ms.into());
    }
    println!("sx-probe {report}");
    app.exit(0);
}
