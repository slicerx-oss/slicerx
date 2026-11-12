// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Bodies as Rust values: the four primitives against their exact volumes and surfaces, what is refused before the
// kernel is asked, and what a build without the kernel answers.
use std::f64::consts::PI;
use sx_brep::{Body, Curve, Error, Surface};

fn close(a: f64, b: f64) {
    assert!((a - b).abs() <= 1e-6 * b.abs().max(1.0), "{a} != {b}");
}

fn close3(a: [f64; 3], b: [f64; 3]) {
    for i in 0..3 {
        assert!((a[i] - b[i]).abs() <= 1e-9, "{a:?} != {b:?}");
    }
}

fn refusal(made: Result<Body, Error>) -> String {
    made.expect_err("a refusal").to_string()
}

#[test]
fn without_the_kernel_every_maker_says_so() {
    if sx_brep::KERNEL {
        return;
    }
    let none = "this build has no B-rep kernel (packages/brep/scripts/fetch-smlib.sh, then build again)";
    assert_eq!(refusal(Body::cuboid([0.0; 3], [1.0; 3])), none);
    assert_eq!(refusal(Body::cylinder([0.0; 3], 1.0, 1.0)), none);
    assert_eq!(refusal(Body::cone([0.0; 3], 1.0, 0.0, 1.0)), none);
    assert_eq!(refusal(Body::sphere([0.0; 3], 1.0)), none);
}

// refused before the kernel is asked, so the same with the kernel or without
#[test]
fn bad_sizes_are_refused_in_words() {
    let more = |what: &str| format!("{what}: must be more than 0 mm");
    let number = |what: &str| format!("{what}: must be a finite number");
    for bad in [0.0, -1.0] {
        assert_eq!(refusal(Body::cuboid([0.0; 3], [bad, 1.0, 1.0])), more("size"));
        assert_eq!(refusal(Body::cuboid([0.0; 3], [1.0, bad, 1.0])), more("size"));
        assert_eq!(refusal(Body::cuboid([0.0; 3], [1.0, 1.0, bad])), more("size"));
        assert_eq!(refusal(Body::cylinder([0.0; 3], bad, 1.0)), more("radius"));
        assert_eq!(refusal(Body::cylinder([0.0; 3], 1.0, bad)), more("height"));
        assert_eq!(refusal(Body::cone([0.0; 3], bad, 0.0, 1.0)), more("base radius"));
        assert_eq!(refusal(Body::cone([0.0; 3], 1.0, 0.0, bad)), more("height"));
        // the kernel itself takes a sphere of radius -1 and reports success
        assert_eq!(refusal(Body::sphere([0.0; 3], bad)), more("radius"));
    }
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(refusal(Body::cuboid([bad, 0.0, 0.0], [1.0; 3])), number("corner"));
        assert_eq!(refusal(Body::cuboid([0.0; 3], [1.0, bad, 1.0])), number("size"));
        assert_eq!(refusal(Body::cylinder([0.0, bad, 0.0], 1.0, 1.0)), number("base"));
        assert_eq!(refusal(Body::cylinder([0.0; 3], bad, 1.0)), number("radius"));
        assert_eq!(refusal(Body::cylinder([0.0; 3], 1.0, bad)), number("height"));
        assert_eq!(
            refusal(Body::cone([0.0, 0.0, bad], 1.0, 0.0, 1.0)),
            number("base")
        );
        assert_eq!(
            refusal(Body::cone([0.0; 3], bad, 0.0, 1.0)),
            number("base radius")
        );
        assert_eq!(refusal(Body::cone([0.0; 3], 1.0, bad, 1.0)), number("top radius"));
        assert_eq!(refusal(Body::cone([0.0; 3], 1.0, 0.0, bad)), number("height"));
        assert_eq!(refusal(Body::sphere([bad, 0.0, 0.0], 1.0)), number("center"));
        assert_eq!(refusal(Body::sphere([0.0; 3], bad)), number("radius"));
    }
    let top = "top radius: must be from 0 mm to the base radius";
    assert_eq!(refusal(Body::cone([0.0; 3], 1.0, -0.5, 1.0)), top);
    assert_eq!(refusal(Body::cone([0.0; 3], 1.0, 1.5, 1.0)), top);
}

#[test]
fn a_box_has_its_volume_bounds_planes_and_edges() {
    if !sx_brep::KERNEL {
        return;
    }
    let body = Body::cuboid([1.0, 2.0, 3.0], [20.0, 30.0, 40.0]).expect("a box");
    close(body.volume().unwrap(), 24000.0);
    let (min, max) = body.bounds().unwrap();
    close3(min, [1.0, 2.0, 3.0]);
    close3(max, [21.0, 32.0, 43.0]);
    let faces = body.faces().unwrap();
    assert_eq!(faces.len(), 6);
    // two planes square to each axis, one through each end of the box
    let mut through = [[false; 2]; 3];
    for face in &faces {
        let Surface::Plane { frame } = face.surface() else {
            panic!("a box face is a plane, not {:?}", face.surface());
        };
        let axis = (0..3).find(|&a| frame.z[a].abs() > 0.5).expect("an axis");
        close(frame.z[axis].abs(), 1.0);
        // z is x cross y, as the kernel builds it
        let cross = [
            frame.x[1] * frame.y[2] - frame.x[2] * frame.y[1],
            frame.x[2] * frame.y[0] - frame.x[0] * frame.y[2],
            frame.x[0] * frame.y[1] - frame.x[1] * frame.y[0],
        ];
        close3(cross, frame.z);
        let end = usize::from((frame.origin[axis] - max[axis]).abs() < 1e-9);
        close(frame.origin[axis], [min[axis], max[axis]][end]);
        through[axis][end] = true;
    }
    assert_eq!(through, [[true; 2]; 3]);
    let edges = body.edges().unwrap();
    assert_eq!(edges.len(), 12);
    for edge in &edges {
        assert_eq!(edge.curve(), Curve::Line);
        assert!(!edge.is_tangent() && !edge.is_closed());
        let joined = edge.faces();
        assert_eq!(joined.len(), 2);
        assert_ne!(joined[0], joined[1]);
        assert!(joined.iter().all(|f| faces.contains(f)));
        let (a, b) = edge.ends().expect("two ends");
        let length = (0..3).map(|i| (a[i] - b[i]).abs()).sum::<f64>();
        assert!(
            [20.0, 30.0, 40.0].iter().any(|l| (length - l).abs() < 1e-9),
            "{length}"
        );
    }
}

#[test]
fn a_cylinder_reads_back_as_a_cylinder_between_two_planes() {
    if !sx_brep::KERNEL {
        return;
    }
    let body = Body::cylinder([5.0, -4.0, 2.0], 10.0, 20.0).expect("a cylinder");
    close(body.volume().unwrap(), PI * 100.0 * 20.0);
    let (min, max) = body.bounds().unwrap();
    close3(min, [-5.0, -14.0, 2.0]);
    close3(max, [15.0, 6.0, 22.0]);
    let surfaces: Vec<Surface> = body.faces().unwrap().iter().map(sx_brep::Face::surface).collect();
    assert_eq!(surfaces.len(), 3, "{surfaces:?}");
    let mut planes = 0;
    let mut round = 0;
    for surface in surfaces {
        match surface {
            Surface::Plane { frame } => {
                planes += 1;
                close(frame.z[2].abs(), 1.0);
            }
            Surface::Cylinder { frame, radius } => {
                round += 1;
                close(radius, 10.0);
                close(frame.z[2].abs(), 1.0);
                close3([frame.origin[0], frame.origin[1], 0.0], [5.0, -4.0, 0.0]);
            }
            // the kernel may keep a cylinder as a cone of no angle
            Surface::Cone {
                frame,
                radius,
                half_angle_deg,
                apex,
            } => {
                round += 1;
                close(radius, 10.0);
                close(half_angle_deg, 0.0);
                assert_eq!(apex, None);
                close3([frame.origin[0], frame.origin[1], 0.0], [5.0, -4.0, 0.0]);
            }
            other => panic!("not a face of a cylinder: {other:?}"),
        }
    }
    assert_eq!((planes, round), (2, 1));
}

#[test]
fn a_cone_reads_back_with_its_angle_and_tip() {
    if !sx_brep::KERNEL {
        return;
    }
    // 45 degrees: base radius 10, a point 10 above
    let body = Body::cone([0.0, 0.0, 0.0], 10.0, 0.0, 10.0).expect("a cone");
    close(body.volume().unwrap(), PI * 100.0 * 10.0 / 3.0);
    let surfaces: Vec<Surface> = body.faces().unwrap().iter().map(sx_brep::Face::surface).collect();
    let cones: Vec<_> = surfaces
        .iter()
        .filter_map(|s| match *s {
            Surface::Cone {
                frame,
                radius,
                half_angle_deg,
                apex,
            } => Some((frame, radius, half_angle_deg, apex)),
            _ => None,
        })
        .collect();
    assert_eq!(cones.len(), 1, "{surfaces:?}");
    let (frame, radius, half_angle_deg, apex) = cones[0];
    close(half_angle_deg.abs(), 45.0);
    close3(apex.expect("a tip"), [0.0, 0.0, 10.0]);
    // the radius is the one at the frame's origin, which sits on the axis
    close3([frame.origin[0], frame.origin[1], 0.0], [0.0; 3]);
    close(radius, 10.0 - frame.origin[2]);
    // cut off at radius 4: a frustum
    let frustum = Body::cone([0.0; 3], 10.0, 4.0, 6.0).expect("a frustum");
    close(frustum.volume().unwrap(), PI * 6.0 / 3.0 * (100.0 + 40.0 + 16.0));
    assert_eq!(frustum.faces().unwrap().len(), 3);
}

#[test]
fn a_sphere_reads_back_with_its_center_and_radius() {
    if !sx_brep::KERNEL {
        return;
    }
    let body = Body::sphere([3.0, -2.0, 7.0], 10.0).expect("a sphere");
    close(body.volume().unwrap(), 4.0 / 3.0 * PI * 1000.0);
    let (min, max) = body.bounds().unwrap();
    close3(min, [-7.0, -12.0, -3.0]);
    close3(max, [13.0, 8.0, 17.0]);
    let surfaces: Vec<Surface> = body.faces().unwrap().iter().map(sx_brep::Face::surface).collect();
    assert_eq!(surfaces.len(), 1);
    let Surface::Sphere { frame, radius } = surfaces[0] else {
        panic!("not a sphere: {surfaces:?}");
    };
    close(radius, 10.0);
    close3(frame.origin, [3.0, -2.0, 7.0]);
}

// resident memory of this process in bytes
#[cfg(target_os = "linux")]
fn resident() -> usize {
    let statm = std::fs::read_to_string("/proc/self/statm").expect("statm");
    let pages: usize = statm
        .split_whitespace()
        .nth(1)
        .expect("resident")
        .parse()
        .expect("a count");
    pages * 4096
}

// a kept box costs the kernel tens of kilobytes, so thousands dropped must leave memory where it was
#[cfg(target_os = "linux")]
#[test]
fn dropping_a_body_frees_it_in_the_kernel() {
    if !sx_brep::KERNEL {
        return;
    }
    let make = || Body::cuboid([0.0; 3], [1.0, 2.0, 3.0]).expect("a box");
    // warm up, so one-time allocations are not counted
    for _ in 0..200 {
        let _dropped_here = make();
    }
    let before = resident();
    for _ in 0..5000 {
        let _dropped_here = make();
    }
    let dropped = resident().saturating_sub(before);
    let kept: Vec<Body> = (0..500).map(|_| make()).collect();
    let held = resident().saturating_sub(before + dropped);
    drop(kept);
    // 5000 dropped take less than a tenth of what 500 kept do
    assert!(
        held > 1 << 20,
        "500 kept boxes took only {held} bytes: the measure is blind"
    );
    assert!(
        dropped * 10 < held,
        "5000 dropped boxes left {dropped} bytes, 500 kept took {held}"
    );
}
