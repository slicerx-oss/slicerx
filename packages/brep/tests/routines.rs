// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Our versions of the kernel routines that cite Numerical Recipes (cpp/routines.cpp) against the kernel's originals:
// routines.golden.json holds what the originals gave on cpp/routine_probe.cpp's inputs, recorded once from an
// unswapped kernel with `SX_BREP_RECORD=<file> cargo test -p sx-brep --features routine-probe -- --ignored record`.
#![cfg(feature = "routine-probe")]

use serde_json::Value;

const GOLDEN: &str = include_str!("routines.golden.json");

// The originals' results for two or more equations solve no system their documentation describes (they also
// leave the last point unset), so ours are held to the math instead, by the check.* residuals.
const ORIGINAL_DIFFERS: &[&str] = &[
    "tridiagonal.2",
    "tridiagonal.6",
    "cornered.3",
    "cornered.4",
    "cornered.6",
];

// A skewed cylinder becomes B-spline surfaces, whose fit depends on which of the equally valid SVD factors the
// transform got, so its volume is held to the exact value (|det| times the cylinder's) instead: the original
// came within 9.3e-6 of it.
const SKEWED_CYLINDER: (&str, usize, f64) = ("transform.1.1", 2, 2.0 * std::f64::consts::PI * 4.0 * 5.0);

fn probe() -> Value {
    serde_json::from_str(&sx_brep::routine_probe().expect("probe runs")).expect("probe output is JSON")
}

fn numbers(v: &Value) -> Vec<f64> {
    v.as_array()
        .expect("an array")
        .iter()
        .map(|x| x.as_f64().unwrap_or(f64::NAN))
        .collect()
}

#[test]
fn matches_the_original_routines() {
    if !sx_brep::KERNEL {
        return;
    }
    let ours = probe();
    let golden: Value = serde_json::from_str(GOLDEN).expect("golden file is JSON");
    let mut bad = Vec::new();
    for (key, want) in golden.as_object().expect("an object") {
        if key.starts_with("check.") || ORIGINAL_DIFFERS.contains(&key.as_str()) {
            continue;
        }
        let Some(got) = ours.get(key) else {
            bad.push(format!("{key}: missing"));
            continue;
        };
        let (mut got, mut want) = (numbers(got), numbers(want));
        if key == SKEWED_CYLINDER.0 {
            let (i, exact) = (SKEWED_CYLINDER.1, SKEWED_CYLINDER.2);
            let off = (got[i] - exact).abs() / exact;
            if off > 1e-5 {
                let v = got[i];
                bad.push(format!("{key}: volume {v} is {off:e} off the exact {exact}"));
            }
            got.remove(i);
            want.remove(i);
        }
        // 1e-6 relative, with a floor for values that are zero up to rounding
        let same = got.len() == want.len()
            && got
                .iter()
                .zip(&want)
                .all(|(g, w)| (g - w).abs() <= 1e-6 * g.abs().max(w.abs()) + 1e-9);
        if !same {
            bad.push(format!("{key}: {got:?} != {want:?}"));
        }
    }
    assert!(bad.is_empty(), "{} cases differ:\n{}", bad.len(), bad.join("\n"));
}

#[test]
fn residuals_are_zero() {
    if !sx_brep::KERNEL {
        return;
    }
    let ours = probe();
    for (key, v) in ours.as_object().expect("an object") {
        if let Some(name) = key.strip_prefix("check.") {
            let worst = numbers(v).into_iter().fold(0.0, f64::max);
            assert!(worst <= 1e-9, "{name}: {worst}");
        }
    }
}

#[test]
#[ignore = "records the golden file from an unswapped kernel"]
fn record() {
    let path = std::env::var("SX_BREP_RECORD").expect("SX_BREP_RECORD=<file>");
    let v = probe();
    std::fs::write(&path, serde_json::to_string_pretty(&v).expect("JSON") + "\n").expect("write");
}
