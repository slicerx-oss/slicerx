// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The size the library shows comes from the scan's bounds, so the bounds must be where the model prints: the
//! build item and component transforms applied, and one plate of a project, never the union of all of them.
#![allow(
    clippy::format_push_string,
    clippy::many_single_char_names,
    clippy::float_cmp,
    reason = "fixture builders; sizes are compared after rounding to a thousandth"
)]

use std::io::{Cursor, Write};
use std::sync::Arc;

use async_trait::async_trait;
use sx_upload_scan::{
    AntiVirus, AvError, AvVerdict, HashBlocklist, Limits, ListingMeta, ScanOutcome, Scanner, Upload, Verdict,
};
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

struct Clean;

#[async_trait]
impl AntiVirus for Clean {
    fn engine(&self) -> &'static str {
        "mock"
    }
    async fn scan(&self, _bytes: &[u8]) -> Result<AvVerdict, AvError> {
        Ok(AvVerdict::Clean)
    }
    async fn version(&self) -> Option<String> {
        None
    }
}

async fn scan(name: &str, bytes: Vec<u8>) -> ScanOutcome {
    let o = scan_with(Limits::default(), name, bytes).await;
    assert_eq!(o.report.verdict, Verdict::Clean, "{:?}", o.report.reasons);
    o
}

async fn scan_with(limits: Limits, name: &str, bytes: Vec<u8>) -> ScanOutcome {
    Scanner::new(limits, Arc::new(HashBlocklist::default()), Arc::new(Clean))
        .scan(Upload {
            file_name: name.into(),
            bytes,
            listing: ListingMeta {
                listing_id: "lst_test".into(),
                listing_slug: "test-model".into(),
                version_id: "ver_test".into(),
                creator_id: "crt_test".into(),
                version_number: "1.0.0".into(),
                creator_slug: "tester".into(),
                creator_name: "Tester".into(),
                title: "Test model".into(),
            },
        })
        .await
}

/// A box object `id` from the origin to `size`.
fn box_object(id: u32, size: [f32; 3]) -> String {
    let [x, y, z] = size;
    let v = [
        [0.0, 0.0, 0.0],
        [x, 0.0, 0.0],
        [x, y, 0.0],
        [0.0, y, 0.0],
        [0.0, 0.0, z],
        [x, 0.0, z],
        [x, y, z],
        [0.0, y, z],
    ];
    let t = [
        [2, 1, 0],
        [3, 2, 0],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 0, 4],
        [3, 4, 7],
    ];
    let mut s = format!("<object id=\"{id}\" type=\"model\"><mesh><vertices>");
    for p in v {
        s.push_str(&format!("<vertex x=\"{}\" y=\"{}\" z=\"{}\"/>", p[0], p[1], p[2]));
    }
    s.push_str("</vertices><triangles>");
    for i in t {
        s.push_str(&format!(
            "<triangle v1=\"{}\" v2=\"{}\" v3=\"{}\"/>",
            i[0], i[1], i[2]
        ));
    }
    s.push_str("</triangles></mesh></object>");
    s
}

fn package(model: &str, settings: Option<&str>) -> Vec<u8> {
    let types = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"model\" ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/>\
<Default Extension=\"config\" ContentType=\"text/xml\"/></Types>";
    let rels = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rel0\" Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\" Target=\"/3D/3dmodel.model\"/></Relationships>";
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    let mut entries = vec![
        ("[Content_Types].xml", types.as_bytes()),
        ("_rels/.rels", rels.as_bytes()),
        ("3D/3dmodel.model", model.as_bytes()),
    ];
    if let Some(s) = settings {
        entries.push(("Metadata/model_settings.config", s.as_bytes()));
    }
    for (name, data) in entries {
        w.start_file(name, SimpleFileOptions::default()).unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

/// A plain 3MF holding `objects` with the given build items.
fn plain(objects: &str, items: &str) -> Vec<u8> {
    package(
        &format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<model unit=\"millimeter\" \
xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\"><resources>{objects}</resources><build>{items}</build></model>"
        ),
        None,
    )
}

fn size(o: &ScanOutcome) -> [f32; 3] {
    let b = o.report.bounds_mm.expect("bounds");
    let s = [0, 1, 2].map(|i| b.max[i] - b.min[i]);
    // Rounded to a thousandth: rotations by sines and cosines leave float dust.
    s.map(|v| (v * 1000.0).round() / 1000.0)
}

const BOX: [f32; 3] = [30.0, 12.0, 8.0];

#[tokio::test]
async fn an_unplaced_box_keeps_its_own_size() {
    let o = scan("box.3mf", plain(&box_object(1, BOX), "<item objectid=\"1\"/>")).await;
    assert_eq!(size(&o), BOX);
}

#[tokio::test]
async fn a_build_item_rotated_about_x_stands_on_its_side() {
    // A quarter turn about X: y goes to z, z to minus y. Row vectors, so the rows are the images of the axes.
    let item = "<item objectid=\"1\" transform=\"1 0 0 0 0 1 0 -1 0 5 40 0\"/>";
    let o = scan("rotated.3mf", plain(&box_object(1, BOX), item)).await;
    assert_eq!(size(&o), [30.0, 8.0, 12.0]);
}

#[tokio::test]
async fn a_build_item_rotated_about_z_swaps_x_and_y() {
    let item = "<item objectid=\"1\" transform=\"0 1 0 -1 0 0 0 0 1 100 100 0\"/>";
    let o = scan("rotated-z.3mf", plain(&box_object(1, BOX), item)).await;
    assert_eq!(size(&o), [12.0, 30.0, 8.0]);
}

#[tokio::test]
async fn a_scaled_build_item_prints_scaled() {
    let item = "<item objectid=\"1\" transform=\"2 0 0 0 0.5 0 0 0 1.5 0 0 0\"/>";
    let o = scan("scaled.3mf", plain(&box_object(1, BOX), item)).await;
    assert_eq!(size(&o), [60.0, 6.0, 12.0]);
}

#[tokio::test]
async fn component_transforms_compose_with_the_build_item() {
    // The component doubles the box, the build item turns it a quarter about X.
    let objects = format!(
        "{}<object id=\"2\" type=\"model\"><components><component objectid=\"1\" transform=\"2 0 0 0 2 0 0 0 2 0 0 0\"/></components></object>",
        box_object(1, BOX)
    );
    let item = "<item objectid=\"2\" transform=\"1 0 0 0 0 1 0 -1 0 0 0 0\"/>";
    let o = scan("components.3mf", plain(&objects, item)).await;
    assert_eq!(size(&o), [60.0, 16.0, 24.0]);
}

/// A Bambu-layout project: object `n` (a box of `sizes[n - 1]`) on plate `n`, the plates 300 mm apart in build space.
fn plates(sizes: &[[f32; 3]]) -> Vec<u8> {
    let mut objects = String::new();
    let mut items = String::new();
    let mut config = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<config>");
    for (n, s) in sizes.iter().enumerate() {
        let id = n + 1;
        objects.push_str(&box_object(u32::try_from(id).unwrap(), *s));
        items.push_str(&format!(
            "<item objectid=\"{id}\" transform=\"1 0 0 0 1 0 0 0 1 {} 0 0\"/>",
            300 * n
        ));
        config.push_str(&format!(
            "<object id=\"{id}\"><metadata key=\"name\" value=\"Box {id}\"/></object><plate><metadata key=\"plater_id\" value=\"{id}\"/>\
<model_instance><metadata key=\"object_id\" value=\"{id}\"/></model_instance></plate>"
        ));
    }
    config.push_str("</config>");
    package(
        &format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<model unit=\"millimeter\" \
xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\"><resources>{objects}</resources><build>{items}</build></model>"
        ),
        Some(&config),
    )
}

#[tokio::test]
async fn a_project_on_several_plates_is_measured_on_its_largest_plate() {
    // The union would be 340 mm wide; the first plate, which the checks read, is the small box.
    let o = scan("plates.3mf", plates(&[[10.0, 10.0, 10.0], [40.0, 20.0, 5.0]])).await;
    assert_eq!(size(&o), [40.0, 20.0, 5.0]);
    assert_eq!((o.report.bounds_plate, o.report.plate_count), (Some(2), Some(2)));
    assert_eq!(o.report.triangle_count, Some(12));
    // The first of two equal plates.
    let o = scan(
        "even.3mf",
        plates(&[[10.0, 20.0, 5.0], [20.0, 10.0, 5.0], [5.0, 5.0, 5.0]]),
    )
    .await;
    assert_eq!(size(&o), [10.0, 20.0, 5.0]);
    assert_eq!((o.report.bounds_plate, o.report.plate_count), (Some(1), Some(3)));
}

#[tokio::test]
async fn single_plate_files_name_plate_one() {
    let o = scan("box.3mf", plain(&box_object(1, BOX), "<item objectid=\"1\"/>")).await;
    assert_eq!((o.report.bounds_plate, o.report.plate_count), (Some(1), Some(1)));
    let v = serde_json::to_value(&o.report).unwrap();
    assert_eq!(
        (v["boundsPlate"].clone(), v["plateCount"].clone()),
        (1.into(), 1.into())
    );
}

#[tokio::test]
async fn a_plate_past_the_size_limit_is_refused() {
    let limits = Limits {
        max_extent_mm: 100.0,
        ..Limits::default()
    };
    let o = scan_with(
        limits,
        "plates.3mf",
        plates(&[[10.0, 10.0, 10.0], [400.0, 20.0, 5.0]]),
    )
    .await;
    assert_eq!(o.report.verdict, Verdict::Rejected);
    assert_eq!(o.report.reason_codes, vec!["mesh_too_large"]);
}
