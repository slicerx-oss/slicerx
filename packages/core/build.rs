// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Sets `SX_BUILD_DATE` (`yyyy-mm-dd`, from `SOURCE_DATE_EPOCH` when set, else the build day in UTC), the
//! build date Ultimaker's G-code header carries.
//!
//! Writes the keys whose type is a percent (`percent` and `percents` in `packages/settings/schema.json`,
//! Orca's `coPercent` and `coPercents`), one per line, so the configuration block writes them with their `%`,
//! and the whole number keys (`int` and `ints`, Orca's `coInt` and `coInts`), which the placeholder language
//! reads as integers, and copies `packages/settings/defaults.json` next to them, with the head shapes the
//! collision check uses (`packages/ui/viewport/data/head-shapes.json`).
//!
//! The published crate has neither folder, so it reads the copies in `data/` instead.
//! `tests/published_data.rs` checks that they match; `SX_UPDATE_CORE_DATA=1` rewrites them.

use std::path::Path;

fn main() {
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    let out = Path::new(&std::env::var("OUT_DIR").unwrap_or_default()).to_path_buf();
    let settings = here.join("../settings");
    let schema = settings.join("schema.json");
    if schema.exists() {
        println!("cargo:rerun-if-changed={}", schema.display());
        let text =
            std::fs::read_to_string(&schema).unwrap_or_else(|e| panic!("reading {}: {e}", schema.display()));
        let parsed: serde_json::Value =
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("parsing {}: {e}", schema.display()));
        for (types, file) in [
            (["percent", "percents"], "percent_keys.txt"),
            (["int", "ints"], "int_keys.txt"),
        ] {
            let mut keys: Vec<&str> = parsed["settings"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .filter(|d| d["type"].as_str().is_some_and(|t| types.contains(&t)))
                .filter_map(|d| d["key"].as_str())
                .collect();
            keys.sort_unstable();
            keys.dedup();
            write(&out.join(file), keys.join("\n").as_bytes());
        }
        copy(&settings.join("defaults.json"), &out.join("defaults.json"));
    } else {
        for file in ["percent_keys.txt", "int_keys.txt", "defaults.json"] {
            copy(&here.join("data").join(file), &out.join(file));
        }
    }
    // heimdall's heads, racks and docks, generated from the ones Preview draws.
    let shapes = here.join("../ui/viewport/data/head-shapes.json");
    if shapes.exists() {
        copy(&shapes, &out.join("head-shapes.json"));
    } else {
        copy(&here.join("data/head-shapes.json"), &out.join("head-shapes.json"));
    }

    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    let secs = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0))
        });
    let (y, m, d) = civil(secs.div_euclid(86_400));
    println!("cargo:rustc-env=SX_BUILD_DATE={y:04}-{m:02}-{d:02}");
}

fn copy(from: &Path, to: &Path) {
    println!("cargo:rerun-if-changed={}", from.display());
    let bytes = std::fs::read(from).unwrap_or_else(|e| panic!("reading {}: {e}", from.display()));
    write(to, &bytes);
}

fn write(to: &Path, bytes: &[u8]) {
    std::fs::write(to, bytes).unwrap_or_else(|e| panic!("writing {}: {e}", to.display()));
}

/// Days since 1970-01-01 to a calendar date (Howard Hinnant's `civil_from_days`).
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}
