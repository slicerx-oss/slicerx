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
    let values = v.as_array().expect("an array");
    assert!(!values.is_empty(), "missing probe measurements");
    values
        .iter()
        .map(|x| {
            x.as_f64()
                .filter(|value| value.is_finite())
                .expect("finite numeric probe measurement")
        })
        .collect()
}

fn worst_error(v: &Value) -> f64 {
    numbers(v).into_iter().map(f64::abs).fold(0.0, f64::max)
}

#[test]
fn probe_values_must_be_present_and_numeric() {
    for invalid in [
        serde_json::json!([null]),
        serde_json::json!([]),
        serde_json::json!(["1"]),
    ] {
        assert!(std::panic::catch_unwind(|| numbers(&invalid)).is_err());
    }
}

#[test]
fn error_checks_do_not_hide_invalid_measurements() {
    for invalid in [serde_json::json!([null]), serde_json::json!([])] {
        assert!(std::panic::catch_unwind(|| worst_error(&invalid)).is_err());
    }
    assert!((worst_error(&serde_json::json!([-0.5, 0.2])) - 0.5).abs() < f64::EPSILON);
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
        if key.starts_with("check.")
            || key.starts_with("accuracy.")
            || ORIGINAL_DIFFERS.contains(&key.as_str())
        {
            continue;
        }
        let Some(got) = ours.get(key) else {
            bad.push(format!("{key}: missing"));
            continue;
        };
        let (mut got, mut want) = (numbers(got), numbers(want));
        // a singular matrix's solution is rounding noise around a substituted pivot, and the noise differs between
        // the x86 and arm64 builds: only the status has to agree
        if key.starts_with("lu.rank") {
            if got.first() != want.first() {
                bad.push(format!("{key}: status {:?} != {:?}", got.first(), want.first()));
            }
            continue;
        }
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
        // the fixed steps and the interpolation are the same formulas as the original, so they agree to rounding;
        // the rest to 1e-6 relative, with a floor for values that are zero up to rounding
        let exact = [
            "ode.rk4",
            "ode.cashkarp",
            "ode.midpoint.",
            "interpolate.",
            "trapezoid",
        ]
        .iter()
        .any(|p| key.starts_with(p));
        let (rel, floor) = if exact { (1e-12, 1e-14) } else { (1e-6, 1e-9) };
        let same = got.len() == want.len()
            && got
                .iter()
                .zip(&want)
                .all(|(g, w)| (g - w).abs() <= rel * g.abs().max(w.abs()) + floor);
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
    let mut checked = 0;
    for (key, v) in ours.as_object().expect("an object") {
        if let Some(name) = key.strip_prefix("check.") {
            let worst = worst_error(v);
            assert!(worst <= 1e-9, "{name}: {worst}");
            checked += 1;
        }
    }
    assert!(checked > 0, "probe returned no residual checks");
}

// Adaptive integration may take other steps than the original and still be right, so ours is held to the exact
// value instead: within the accuracy asked for. An ODE's tolerance bounds each step's error, and the global error
// adds those up over the run: the worst measured is 3.35 times (ode.oscillator.9), so ODEs get 4.
#[test]
fn meets_the_requested_accuracy() {
    if !sx_brep::KERNEL {
        return;
    }
    let ours = probe();
    let mut bad = Vec::new();
    let mut checked = 0;
    for (key, v) in ours.as_object().expect("an object") {
        if let Some(name) = key.strip_prefix("accuracy.") {
            let worst = worst_error(v);
            checked += 1;
            let allowed = if name.starts_with("ode.") { 4.0 } else { 1.0 };
            if worst > allowed {
                bad.push(format!("{name}: {worst:e} of the accuracy asked for"));
            }
        }
    }
    assert!(checked > 0, "probe returned no accuracy checks");
    assert!(bad.is_empty(), "{} cases miss:\n{}", bad.len(), bad.join("\n"));
}

#[test]
#[ignore = "records the golden file from an unswapped kernel"]
fn record() {
    let path = std::env::var("SX_BREP_RECORD").expect("SX_BREP_RECORD=<file>");
    let v = probe();
    std::fs::write(&path, serde_json::to_string_pretty(&v).expect("JSON") + "\n").expect("write");
}
