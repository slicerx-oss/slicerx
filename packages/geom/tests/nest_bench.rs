// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the nesting benchmark as a test: on every plate sx-geom must place at least as many parts as
//! the reference counts in `nest_bench/reference.json` (its own as recorded, and `OrcaSlicer`
//! 2.4.2 and Bambu Studio 2.8.2 on the same parts and bed with their default settings and with
//! the best of the other settings tried, raw runs in `nest_bench/runs`), with every part clear of
//! the others and the bed edge. refresh the reference with `packages/geom/scripts/nest-bench.mjs`

#[path = "nest_bench/parts.rs"]
mod parts;

use serde_json::Value;

fn reference() -> Value {
    serde_json::from_str(include_str!("nest_bench/reference.json")).unwrap_or(Value::Null)
}

fn check(name: &str) {
    let r = reference();
    let gap = r["gapMm"].as_f64().unwrap_or(2.0);
    let want = &r["plates"][name];
    assert!(want.is_object(), "{name} has no reference counts");
    let plate = parts::plates()
        .into_iter()
        .find(|p| p.name == name)
        .unwrap_or_else(|| panic!("no plate {name}"));
    let o = parts::arrange(&plate, gap, 10.0, 0);
    assert!(o.clear, "{name}: parts overlap or leave the bed");
    for key in ["ours", "orca", "orcaBest", "bambu", "bambuBest"] {
        if let Some(n) = want[key].as_u64() {
            assert!(
                u64::from(o.placed) >= n,
                "{name}: {} parts placed, {key} placed {n}",
                o.placed
            );
        }
    }
}

macro_rules! plates {
    ($($test:ident => $name:literal),* $(,)?) => {
        $(
            #[test]
            fn $test() {
                check($name);
            }
        )*

        #[test]
        fn every_plate_has_a_test_and_a_reference() {
            let mut tested = vec![$($name),*];
            tested.sort_unstable();
            let mut all: Vec<String> = parts::plates().into_iter().map(|p| p.name).collect();
            all.sort_unstable();
            assert_eq!(tested, all);
            let r = reference();
            for name in &all {
                assert!(r["plates"][name].is_object(), "{name} has no reference counts");
            }
        }
    };
}

plates!(
    l_brackets => "l-brackets",
    rings_washers => "rings-washers",
    gears => "gears",
    organic => "organic",
    mixed => "mixed",
    crosses_tees => "crosses-tees",
    c_clips => "c-clips",
    frames => "frames",
    stars => "stars",
    bars_triangles => "bars-triangles",
    fill_l60 => "fill-l60",
    fill_ring70 => "fill-ring70",
    fill_gear24 => "fill-gear24",
    fill_crescent60 => "fill-crescent60",
    fill_hook => "fill-hook",
    fill_cross60 => "fill-cross60",
    fill_clip50 => "fill-clip50",
    fill_frame80 => "fill-frame80",
    fill_star30 => "fill-star30",
    fill_tri50 => "fill-tri50",
);
