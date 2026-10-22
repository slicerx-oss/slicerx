use std::fmt::Write;

use sx_core::{config::PrintConfig, printtime};

fn profile(native: bool) -> PrintConfig {
    PrintConfig::from_json(
        &serde_json::to_vec(&serde_json::json!({
            "gcode_flavor": "marlin",
            "printer_model": if native { "Bambu Lab P1S" } else { "generic" },
            "machine_max_acceleration_x": [10000],
            "machine_max_acceleration_y": [10000],
            "machine_max_acceleration_extruding": [10000],
            "machine_max_speed_x": [500],
            "machine_max_speed_y": [500]
        }))
        .unwrap(),
    )
    .unwrap()
}

fn circles(parts: u32, clockwise: bool) -> Vec<u8> {
    let mut code =
        String::from("G21\nG90\nM83\nM204 P10000 R5000 T10000\nM205 X9 Y9 Z3 E2.5\nG92 X10 Y0 Z0 E0\n");
    let sign = if clockwise { -1.0 } else { 1.0 };
    let command = if clockwise { "G2" } else { "G3" };
    for _ in 0..100 {
        for part in 0..parts {
            let start = sign * std::f64::consts::TAU * f64::from(part) / f64::from(parts);
            let end = sign * std::f64::consts::TAU * f64::from(part + 1) / f64::from(parts);
            writeln!(
                code,
                "{command} X{:.8} Y{:.8} I{:.8} J{:.8} E{:.8} F21000",
                10.0 * libm::cos(end),
                10.0 * libm::sin(end),
                -10.0 * libm::cos(start),
                -10.0 * libm::sin(start),
                0.3 * std::f64::consts::TAU / f64::from(parts)
            )
            .unwrap();
        }
    }
    code.push_str("M400\n");
    code.into_bytes()
}

#[test]
fn native_bambu_arc_time_does_not_depend_on_splitting_a_circle() {
    let cfg = profile(true);
    for clockwise in [false, true] {
        let whole = printtime::estimate(&circles(1, clockwise), &cfg, false).total;
        let split = printtime::estimate(&circles(360, clockwise), &cfg, false).total;
        assert!((whole - split).abs() < 0.2, "whole={whole}, split={split}");
        // curvature limits cruise to sqrt(10000 * 10), with brief endpoint ramps.
        let steady = 100.0 * 20.0 * std::f64::consts::PI / 100_000.0_f64.sqrt();
        assert!((whole - steady).abs() < 0.2, "whole={whole}, steady={steady}");
    }
}

#[test]
fn generic_marlin_keeps_its_segmented_arc_model() {
    let time = printtime::estimate(&circles(1, false), &profile(false), false).total;
    assert!((51.0..53.0).contains(&time), "time={time}");
}

#[test]
fn native_arcs_respect_axis_limits_and_carry_the_extruder_speed() {
    let code = circles(1, false);
    let mut cfg = profile(true);
    cfg.raw
        .insert("machine_max_speed_x".into(), serde_json::json!([100]));
    let xy = printtime::estimate(&code, &cfg, false).total;
    let length = 100.0 * 20.0 * std::f64::consts::PI;
    assert!((xy - length / 100.0).abs() < 0.3, "xy={xy}");
    // A Bambu Lab arc takes its extruder speed from the move before it (here none) instead of its own filament per
    // mm, so the extruder limit does not slow it, as in Bambu Studio's estimate.
    cfg.raw
        .insert("machine_max_speed_e".into(), serde_json::json!([0.5]));
    let extrusion = printtime::estimate(&code, &cfg, false).total;
    assert!((extrusion - xy).abs() < 1e-9, "extrusion={extrusion}, xy={xy}");
}

#[test]
fn reversing_native_circles_requires_deceleration() {
    let code = String::from_utf8(circles(1, false)).unwrap();
    let mut reversing = String::new();
    let mut turn = 0;
    for line in code.lines() {
        if line.starts_with("G3 ") {
            turn += 1;
            if turn % 2 == 0 {
                writeln!(reversing, "{}", line.replacen("G3", "G2", 1)).unwrap();
                continue;
            }
        }
        writeln!(reversing, "{line}").unwrap();
    }
    let cfg = profile(true);
    let smooth = printtime::estimate(code.as_bytes(), &cfg, false).total;
    let reversed = printtime::estimate(reversing.as_bytes(), &cfg, false).total;
    assert!(reversed > smooth + 1.0, "smooth={smooth}, reversed={reversed}");
}

#[test]
fn native_helix_respects_z_speed_and_keeps_timing_readback_consistent() {
    let mut code = String::from("G90\nM83\nG92 X10 Y0 Z0 E0\nM204 S10000\n");
    for layer in 0..20 {
        writeln!(code, ";@L {layer} 0").unwrap();
        writeln!(code, "G3 X10 Y0 Z{} I-10 J0 E3 F21000", (layer + 1) * 100).unwrap();
    }
    let mut cfg = profile(true);
    cfg.raw
        .insert("machine_max_speed_z".into(), serde_json::json!([2]));
    let result = printtime::estimate(code.as_bytes(), &cfg, true);
    assert!(result.total >= 1000.0, "{}", result.total);
    assert!(result.total < 1002.0, "{}", result.total);
    assert!((result.segments.iter().sum::<f64>() - result.total).abs() < 1e-6);
    assert!(result.lines.iter().all(|t| t.is_finite()));
    assert!(result.lines.windows(2).all(|t| t[1] >= t[0]));
}

#[test]
fn non_native_firmware_keeps_its_model_even_with_a_bambu_name() {
    let code = circles(4, false);
    let mut generic = profile(false);
    generic.gcode_flavor = sx_core::config::GcodeFlavor::Marlin2;
    let mut named = generic.clone();
    named
        .raw
        .insert("printer_model".into(), serde_json::json!("Bambu Lab P1S"));
    let a = printtime::estimate(&code, &generic, false).total;
    let b = printtime::estimate(&code, &named, false).total;
    assert_eq!(a.to_bits(), b.to_bits());
}
