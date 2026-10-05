// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Release timings for every operation on procedural meshes of about 30,000
//! triangles. Run with `cargo test --release -p sx-geom --test timing -- --ignored --nocapture`.

use std::time::Instant;
use sx_geom::layers::{LayerMode, LayerOptions, plan_layers};
use sx_geom::simplify::{SimplifyOptions, simplify};
use sx_geom::{Plane, build, calib, cut, emboss, hollow, orient, repair, resume, split};

fn torus() -> sx_geom::TriMesh {
    build::torus([0.0, 0.0, 6.0], 20.0, 6.0, 150, 100)
}

fn time<T>(label: &str, f: impl FnOnce() -> T) -> T {
    let t0 = Instant::now();
    let out = f();
    println!("{label:<34} {:>9.2} ms", t0.elapsed().as_secs_f64() * 1e3);
    out
}

#[test]
#[ignore = "timing, run with --release -- --ignored --nocapture"]
#[allow(clippy::too_many_lines, reason = "one timed call per operation")]
fn all_operations_on_30k_triangles() {
    let t = torus();
    assert_eq!(t.triangles.len(), 30_000);
    let plane = Plane::new([0.0, 0.0, 6.0], [0.0, 1.0, 0.0]).unwrap();
    time("section", || cut::section(&t, &plane));
    let r = time("cut", || {
        cut::plane_cut(&t, &plane, &cut::CutOptions::default()).unwrap()
    });
    assert!(r.report.below_edges.is_watertight() && r.report.above_edges.is_watertight());
    for kind in [
        cut::ConnectorKind::Pin,
        cut::ConnectorKind::Dowel,
        cut::ConnectorKind::Dovetail,
    ] {
        let spec = cut::ConnectorSpec {
            kind,
            diameter_mm: 4.0,
            depth_mm: 4.0,
            ..cut::ConnectorSpec::default()
        };
        let r = time(&format!("cut with {kind:?}"), || {
            cut::plane_cut(
                &t,
                &plane,
                &cut::CutOptions {
                    connector: Some(spec),
                },
            )
            .unwrap()
        });
        assert!(
            r.report.below_edges.is_watertight(),
            "{kind:?} {:?}",
            r.report.below_edges
        );
        assert!(
            r.report.above_edges.is_watertight(),
            "{kind:?} {:?}",
            r.report.above_edges
        );
        assert!(
            !r.report.connectors.is_empty(),
            "{kind:?} {:?}",
            r.report.warnings
        );
    }
    let big = {
        let mut m = t.clone();
        m.map_positions(|p| [p[0] * 6.0, p[1] * 6.0, p[2] * 6.0]);
        m
    };
    let s = time("split 312 mm torus to 180 mm", || {
        split::split_to_fit(
            &big,
            &split::SplitOptions {
                build_volume_mm: [180.0, 180.0, 180.0],
                ..split::SplitOptions::default()
            },
        )
        .unwrap()
    });
    println!("  {} parts, {} cuts", s.parts.len(), s.cuts.len());
    time("repair", || {
        repair::repair(&t, &repair::RepairOptions::default()).unwrap()
    });
    time("orient analyze", || {
        orient::analyze(
            &t,
            &orient::Orientation::Down {
                down: [0.0, 0.0, -1.0],
            },
            &orient::OrientOptions::default(),
        )
    });
    time("orient rank 12", || {
        orient::rank(&t, &orient::OrientOptions::default(), 12)
    });
    let (h, rep) = time("hollow 2 mm wall", || {
        hollow::hollow(
            &t,
            &hollow::HollowOptions {
                wall_mm: 2.0,
                ..hollow::HollowOptions::default()
            },
        )
        .unwrap()
    });
    println!(
        "  grid {:?}, {} inner triangles, watertight {}",
        rep.grid,
        rep.inner_triangles,
        h.edge_report().is_watertight()
    );
    let top = build::extrude(
        &[sx_geom::Polygon::simple(sx_geom::poly2d::circle(
            [0.0, 0.0],
            40.0,
            5000,
        ))],
        &sx_geom::vec3::Frame::WORLD,
        0.0,
        10.0,
    )
    .unwrap();
    time("deboss 12 characters", || {
        emboss::emboss_text(
            &top,
            &emboss::EmbossSpec {
                text: "SLICERX 2026".to_owned(),
                point: [0.0, 0.0, 10.0],
                normal: None,
                up: None,
                size_mm: 5.0,
                stroke_mm: None,
                depth_mm: 0.6,
                mode: emboss::EmbossMode::Deboss,
            },
        )
        .unwrap()
    });
    for test in [
        "temp-tower",
        "flow",
        "pressure-advance",
        "retraction",
        "max-volumetric",
        "tolerance",
        "shrinkage",
        "feature-piece",
    ] {
        let req: calib::CalibRequest = serde_json::from_value(serde_json::json!({ "test": test })).unwrap();
        time(&format!("calibrate {test}"), || calib::generate(&req).unwrap());
    }
    time("resume at 7.4 mm", || {
        resume::plan(
            &t,
            &resume::ResumeRequest {
                measured_height_mm: Some(7.4),
                ..resume::ResumeRequest::default()
            },
        )
        .unwrap()
    });
    for mode in [LayerMode::Quality, LayerMode::Strength] {
        time(&format!("layers.plan {mode:?}"), || {
            plan_layers(&t, 0.4, mode, &LayerOptions::default()).unwrap()
        });
    }
    time("simplify to 10 percent", || {
        simplify(
            &t,
            &SimplifyOptions {
                target_ratio: Some(0.1),
                ..SimplifyOptions::default()
            },
        )
        .unwrap()
    });
}
