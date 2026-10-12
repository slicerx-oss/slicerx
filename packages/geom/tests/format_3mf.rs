// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the 3mf reader on the format corpus and on broken archives

#![cfg(feature = "formats")]
#![allow(clippy::float_cmp, reason = "the test meshes sit on whole millimeters")]

use std::fmt::Write as _;
use std::path::PathBuf;
use sx_geom::format::{Layout, PartKind, PartProps, Project, Textures, read_3mf};

fn file(rel: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn read(rel: &str) -> Project {
    read_3mf(&file(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

fn kinds(p: &Project) -> Vec<(String, PartKind)> {
    p.objects
        .iter()
        .flat_map(|o| o.parts.iter().map(|p| (p.name.clone(), p.kind)))
        .collect()
}

#[test]
fn part_types_from_bambu_orca_and_ours() {
    let want = vec![
        ("body".to_owned(), PartKind::Normal),
        ("notch".to_owned(), PartKind::Negative),
        ("modifier".to_owned(), PartKind::Modifier),
        ("blocker".to_owned(), PartKind::SupportBlocker),
        ("enforcer".to_owned(), PartKind::SupportEnforcer),
    ];
    for f in ["subtypes", "bambu-subtypes", "orca-subtypes"] {
        let p = read(&format!("tests/corpus/{f}.3mf"));
        assert_eq!(p.layout, Layout::Bambu, "{f}");
        assert_eq!(p.objects.len(), 1, "{f}");
        let mut got = kinds(&p);
        got.sort_by_key(|(_, k)| *k as u8);
        assert_eq!(got, want, "{f}");
        // the printed body alone is 20 x 20 x 10
        let o = &p.objects[0];
        let body = o.parts.iter().find(|p| p.prints()).expect("a printed part");
        let pts = body.placed(&o.transform, p.unit_scale);
        let size: Vec<f32> = (0..3)
            .map(|c| {
                let (lo, hi) = pts
                    .iter()
                    .fold((f32::MAX, f32::MIN), |(l, h), v| (l.min(v[c]), h.max(v[c])));
                hi - lo
            })
            .collect();
        assert_eq!(size, vec![20.0, 20.0, 10.0], "{f}");
    }
}

#[test]
fn prusaslicer_modifier_and_settings() {
    let p = read("../settings/fixtures/preset-files/prusaslicer-2.9.6.3mf");
    assert_eq!(p.layout, Layout::Prusa);
    let o = &p.objects[0];
    assert_eq!(o.name, "Cube with modifier");
    assert!(
        o.settings
            .iter()
            .any(|(k, v)| k == "fill_pattern" && v == "gyroid")
    );
    let parts: Vec<(&str, PartKind, usize)> = o
        .parts
        .iter()
        .map(|p| (p.name.as_str(), p.kind, p.triangles.len()))
        .collect();
    assert_eq!(
        parts,
        vec![
            ("Cube", PartKind::Normal, 12),
            ("Denser core", PartKind::Modifier, 12)
        ]
    );
    assert!(
        p.files
            .prusa_config
            .as_deref()
            .is_some_and(|c| c.contains("layer_height"))
    );
}

#[test]
fn paint_from_bambu_and_prusaslicer() {
    for f in [
        "../core/cli/tests/fixtures/painted.3mf",
        "tests/corpus/prusa-painted.3mf",
        "tests/corpus/orca-painted.3mf",
    ] {
        let p = read(f);
        let painted: usize = p
            .objects
            .iter()
            .flat_map(|o| &o.parts)
            .map(|p| p.paint.color.len())
            .sum();
        assert_eq!(painted, 4, "{f}");
    }
    let seams: usize = read("../../apps/desktop/src-tauri/src/testdata/seam-cube-xp.3mf")
        .objects
        .iter()
        .flat_map(|o| &o.parts)
        .map(|p| p.paint.seam.len())
        .sum();
    assert!(seams > 0);
}

#[test]
fn plates_and_files() {
    let p = read("../core/bench/models/x-mark-showcase.sx3mf");
    assert!(
        p.files
            .slicerx
            .iter()
            .any(|(n, _)| n == "Metadata/slicerx_history.json")
    );
    assert!(p.files.project_settings.is_some());
    assert!(p.metadata.iter().any(|(k, _)| k == "Application"));
    let p = read("../../apps/web/e2e/fixtures/eight-colors.3mf");
    assert_eq!(p.plates.len(), 1);
    assert_eq!(p.plates[0].objects.len(), p.objects.len());
    assert!(p.objects.iter().all(|o| o.plate == Some(p.plates[0].id)));
    // no _rels/.rels: the root part is found by its usual name
    assert_eq!(read("../core/cli/tests/fixtures/two-boxes.3mf").objects.len(), 2);
}

/// a stored zip of these entries
fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    zip_with(
        entries
            .iter()
            .map(|(n, b)| (*n, b.to_vec(), 0u16, b.len()))
            .collect(),
    )
}

/// entries with a method and a declared size of their own
fn zip_with(entries: Vec<(&str, Vec<u8>, u16, usize)>) -> Vec<u8> {
    let mut out = Vec::new();
    let mut dir = Vec::new();
    let n = u16::try_from(entries.len()).expect("few entries");
    for (name, data, method, size) in entries {
        let at = u32::try_from(out.len()).expect("small");
        let len = u32::try_from(data.len()).expect("small");
        let size = u32::try_from(size).expect("small");
        let name_len = u16::try_from(name.len()).expect("short");
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&[20, 0, 0, 0]);
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&[0; 8]);
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&name_len.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&data);
        dir.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        dir.extend_from_slice(&[20, 0, 20, 0, 0, 0]);
        dir.extend_from_slice(&method.to_le_bytes());
        dir.extend_from_slice(&[0; 8]);
        dir.extend_from_slice(&len.to_le_bytes());
        dir.extend_from_slice(&size.to_le_bytes());
        dir.extend_from_slice(&name_len.to_le_bytes());
        dir.extend_from_slice(&[0; 12]);
        dir.extend_from_slice(&at.to_le_bytes());
        dir.extend_from_slice(name.as_bytes());
    }
    let dir_at = u32::try_from(out.len()).expect("small");
    let dir_len = u32::try_from(dir.len()).expect("small");
    out.extend_from_slice(&dir);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&n.to_le_bytes());
    out.extend_from_slice(&n.to_le_bytes());
    out.extend_from_slice(&dir_len.to_le_bytes());
    out.extend_from_slice(&dir_at.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out
}

const BOX: &str = r#"<object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>"#;

fn model(resources: &str, build: &str) -> String {
    format!(
        r#"<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>{resources}</resources><build>{build}</build></model>"#
    )
}

fn err(bytes: &[u8]) -> String {
    match read_3mf(bytes) {
        Ok(_) => panic!("read a broken file"),
        Err(e) => e.to_string(),
    }
}

#[test]
fn refuses_what_it_cannot_read() {
    assert!(err(b"not a zip").contains("not a ZIP"));
    let bad_index = model(&BOX.replace(r#"v3="2""#, r#"v3="7""#), r#"<item objectid="1"/>"#);
    assert!(err(&zip_of(&[("3D/3dmodel.model", bad_index.as_bytes())])).contains("refused index 1"));
    let bad_vertex = model(&BOX.replace(r#"x="1""#, r#"x="nan""#), r#"<item objectid="1"/>"#);
    assert!(err(&zip_of(&[("3D/3dmodel.model", bad_vertex.as_bytes())])).contains("refused vertex 1 1"));
    let unit = model(BOX, r#"<item objectid="1"/>"#).replace("millimeter", "furlong");
    assert!(err(&zip_of(&[("3D/3dmodel.model", unit.as_bytes())])).contains("refused unit 0 0 furlong"));
    let missing = model(BOX, r#"<item objectid="9"/>"#);
    assert!(err(&zip_of(&[("3D/3dmodel.model", missing.as_bytes())])).contains("object 9 is missing"));
    // a component that contains itself
    let cycle = model(
        r#"<object id="2" type="model"><components><component objectid="2"/></components></object>"#,
        r#"<item objectid="2"/>"#,
    );
    assert!(err(&zip_of(&[("3D/3dmodel.model", cycle.as_bytes())])).contains("nest too deep"));
    // a part that inflates past the size it declares
    let big = model(BOX, r#"<item objectid="1"/>"#);
    let packed = miniz_oxide::deflate::compress_to_vec(big.as_bytes(), 6);
    let bomb = zip_with(vec![("3D/3dmodel.model", packed, 8, 16)]);
    assert!(err(&bomb).contains("inflates past its size"));
}

#[test]
fn components_place_shared_meshes_twice() {
    let resources = format!(
        r#"{BOX}<object id="2" type="model"><components><component objectid="1"/><component objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></components></object>"#
    );
    let p = read_3mf(&zip_of(&[(
        "3D/3dmodel.model",
        model(&resources, r#"<item objectid="2"/><item objectid="1"/>"#).as_bytes(),
    )]))
    .expect("reads");
    assert_eq!(p.layout, Layout::Plain);
    assert_eq!(p.objects.len(), 2);
    assert_eq!(p.objects[0].parts.len(), 2);
    let moved = p.objects[0].parts[1].placed(&p.objects[0].transform, 1.0);
    assert_eq!(moved[1], [6.0, 0.0, 0.0]);
    // the mesh is still there for the second item after the first took copies
    assert_eq!(p.objects[1].parts[0].triangles.len(), 1);
}

#[test]
fn json_operation_gives_meshes_as_buffers() {
    let bytes = file("tests/corpus/subtypes.3mf");
    let load = |p: &str| -> sx_geom::Result<Vec<u8>> {
        assert_eq!(p, "mem:0");
        Ok(bytes.clone())
    };
    let out = sx_geom::json::call_with_files("format.read3mf", r#"{"data":{"path":"mem:0"}}"#, &load)
        .expect("reads");
    let v: serde_json::Value = serde_json::from_str(&out).expect("json");
    assert_eq!(v["layout"], "bambu");
    let parts = v["objects"][0]["parts"].as_array().expect("parts");
    let kinds: Vec<&str> = parts.iter().filter_map(|p| p["kind"].as_str()).collect();
    assert_eq!(
        kinds,
        [
            "normal",
            "negative",
            "modifier",
            "support_blocker",
            "support_enforcer"
        ]
    );
    let buffers = sx_geom::json::take_out_files();
    // positions and triangles of each of the five parts
    assert_eq!(buffers.len(), 10);
    // 8 corners and 12 triangles of a box
    assert_eq!(buffers[0].to_bytes().len(), 8 * 12);
    assert_eq!(buffers[1].to_bytes().len(), 12 * 12);
}

const CUBE: &str = "tests/corpus/textured-cube.3mf";
const ROOT: &str = "3D/3dmodel.model";

/// the textured cube's own entries, by name
fn cube_entries() -> Vec<(String, Vec<u8>)> {
    let bytes = file(CUBE);
    let names = read(CUBE).entries;
    names
        .into_iter()
        .map(|n| {
            let b = sx_geom::format::read_entry(&bytes, &n).expect("entry");
            (n, b)
        })
        .collect()
}

/// the textured cube with its model part edited
fn cube_with(edit: impl Fn(String) -> String, extra: &[(&str, &[u8])]) -> Vec<u8> {
    let mut entries = cube_entries();
    for (n, b) in &mut entries {
        if n == ROOT {
            *b = edit(String::from_utf8(b.clone()).expect("utf-8")).into_bytes();
        }
    }
    let mut all: Vec<(&str, &[u8])> = entries.iter().map(|(n, b)| (n.as_str(), b.as_slice())).collect();
    all.extend_from_slice(extra);
    zip_of(&all)
}

#[test]
fn texture_coordinates_and_references_from_the_materials_extension() {
    let bytes = file(CUBE);
    let p = read(CUBE);
    assert!(p.notes.is_empty(), "{:?}", p.notes);
    let [image] = p.textures.images.as_slice() else {
        panic!("one texture")
    };
    assert_eq!((image.model.as_str(), image.id), (ROOT, 1));
    assert_eq!(image.path, "3D/Texture/checker.png");
    assert_eq!(image.content_type, "image/png");
    assert_eq!(image.tilestyle_u.as_deref(), Some("wrap"));
    assert_eq!(image.tilestyle_v.as_deref(), Some("mirror"));
    assert_eq!(image.filter.as_deref(), Some("nearest"));
    // the image is read on demand, from the archive
    let png = image.read(&bytes).expect("image");
    assert_eq!(png.len() as u64, image.size);
    assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
    let group = p.textures.group(ROOT, 2).expect("group");
    assert_eq!(group.texture, 1);
    assert_eq!(group.uvs.len(), 8);
    assert_eq!(group.uvs[1], [1.0, 0.0]);
    assert_eq!(group.uvs[7], [0.75, 0.75]);
    let part = &p.objects[0].parts[0];
    assert_eq!(
        part.props,
        PartProps {
            model: ROOT.to_owned(),
            default: Some((2, 7)),
            triangles: vec![(0, 2, [0, 2, 1]), (1, 2, [1, 2, 3]), (2, 2, [4, 4, 4])],
        }
    );
    assert_eq!(part.props.of(1), Some((2, [1, 2, 3])));
    assert_eq!(part.props.of(11), Some((2, [7, 7, 7])));
    // an untextured project has none
    let plain = read("tests/corpus/subtypes.3mf");
    assert!(plain.textures.is_empty());
    assert!(plain.objects[0].parts.iter().all(|p| p.props.is_empty()));
}

/// the materials resources and triangles of a one-part project, as a model part: test-only, to read back
fn write_textured(p: &Project) -> String {
    let part = &p.objects[0].parts[0];
    let mut res = String::new();
    for t in &p.textures.images {
        let _ = write!(
            res,
            r#"<m:texture2d id="{}" path="/{}" contenttype="{}""#,
            t.id, t.path, t.content_type
        );
        for (k, v) in [
            ("tilestyleu", &t.tilestyle_u),
            ("tilestylev", &t.tilestyle_v),
            ("filter", &t.filter),
        ] {
            if let Some(v) = v {
                let _ = write!(res, r#" {k}="{v}""#);
            }
        }
        res += "/>";
    }
    for g in &p.textures.groups {
        let _ = write!(res, r#"<m:texture2dgroup id="{}" texid="{}">"#, g.id, g.texture);
        for [u, v] in &g.uvs {
            let _ = write!(res, r#"<m:tex2coord u="{u}" v="{v}"/>"#);
        }
        res += "</m:texture2dgroup>";
    }
    let default = part
        .props
        .default
        .map(|(pid, i)| format!(r#" pid="{pid}" pindex="{i}""#))
        .unwrap_or_default();
    let _ = write!(res, r#"<object id="3" type="model"{default}><mesh><vertices>"#);
    for [x, y, z] in &part.positions {
        let _ = write!(res, r#"<vertex x="{x}" y="{y}" z="{z}"/>"#);
    }
    res += "</vertices><triangles>";
    for (k, [a, b, c]) in part.triangles.iter().enumerate() {
        let own = u32::try_from(k)
            .ok()
            .and_then(|k| part.props.triangles.iter().find(|t| t.0 == k))
            .map(|(_, pid, [p1, p2, p3])| format!(r#" pid="{pid}" p1="{p1}" p2="{p2}" p3="{p3}""#))
            .unwrap_or_default();
        let _ = write!(res, r#"<triangle v1="{a}" v2="{b}" v3="{c}"{own}/>"#);
    }
    res += "</triangles></mesh></object>";
    model(&res, r#"<item objectid="3"/>"#).replace(
        "<model ",
        r#"<model xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" requiredextensions="m" "#,
    )
}

#[test]
fn textures_round_trip() {
    let bytes = file(CUBE);
    let first = read(CUBE);
    let images: Vec<(String, Vec<u8>)> = first
        .textures
        .images
        .iter()
        .map(|t| (t.path.clone(), t.read(&bytes).expect("image")))
        .collect();
    let model = write_textured(&first);
    let mut entries: Vec<(&str, &[u8])> = vec![(ROOT, model.as_bytes())];
    entries.extend(images.iter().map(|(n, b)| (n.as_str(), b.as_slice())));
    let again_bytes = zip_of(&entries);
    let again = read_3mf(&again_bytes).expect("reads again");
    assert!(again.notes.is_empty(), "{:?}", again.notes);
    assert_eq!(again.textures, first.textures);
    let (a, b) = (&again.objects[0].parts[0], &first.objects[0].parts[0]);
    assert_eq!(a.props, b.props);
    assert_eq!(a.positions, b.positions);
    assert_eq!(a.triangles, b.triangles);
    for (t, u) in again.textures.images.iter().zip(&first.textures.images) {
        assert_eq!(
            t.read(&again_bytes).expect("again"),
            u.read(&bytes).expect("first")
        );
    }
}

#[test]
fn a_part_by_triangle_range_renumbers_its_texture_references() {
    let config = br#"<?xml version="1.0"?><config><object id="3"><volume firstid="0" lastid="1"/><volume firstid="2" lastid="11"/></object></config>"#;
    let p = read_3mf(&cube_with(|m| m, &[("Metadata/Slic3r_PE_model.config", config)])).expect("reads");
    let parts = &p.objects[0].parts;
    assert_eq!(parts.len(), 2);
    assert_eq!(parts[0].props.triangles, [(0, 2, [0, 2, 1]), (1, 2, [1, 2, 3])]);
    assert_eq!(parts[1].props.triangles, [(0, 2, [4, 4, 4])]);
    assert_eq!(parts[1].props.default, Some((2, 7)));
}

#[test]
fn texture_data_that_does_not_read_is_left_out_with_a_note() {
    let notes = |p: &Project| p.notes.join("\n");
    // the image is missing from the archive: the texture, its group and the references to it go
    let mut entries = cube_entries();
    entries.retain(|(n, _)| n != "3D/Texture/checker.png");
    let all: Vec<(&str, &[u8])> = entries.iter().map(|(n, b)| (n.as_str(), b.as_slice())).collect();
    let p = read_3mf(&zip_of(&all)).expect("still reads");
    assert_eq!(p.textures, Textures::default());
    assert!(p.objects[0].parts[0].props.is_empty());
    assert!(notes(&p).contains("which the archive lacks"), "{}", notes(&p));
    assert_eq!(p.objects[0].parts[0].triangles.len(), 12);
    // a coordinate that does not read drops its group
    let p = read_3mf(&cube_with(|m| m.replacen(r#"u="1""#, r#"u="one""#, 1), &[])).expect("still reads");
    assert!(p.textures.groups.is_empty());
    assert_eq!(p.textures.images.len(), 1);
    assert!(
        notes(&p).contains("texture group 2 has an id, texture or coordinate"),
        "{}",
        notes(&p)
    );
    // a corner index that does not read, and one past the group, drop those triangles' references only
    let p = read_3mf(&cube_with(
        |m| {
            m.replace(r#"p1="4""#, r#"p1="four""#)
                .replace(r#"p3="3""#, r#"p3="99""#)
        },
        &[],
    ))
    .expect("still reads");
    assert_eq!(p.objects[0].parts[0].props.triangles, [(0, 2, [0, 2, 1])]);
    assert_eq!(p.objects[0].parts[0].props.default, Some((2, 7)));
    assert!(
        notes(&p).contains("1 triangles name properties that do not read"),
        "{}",
        notes(&p)
    );
    assert!(notes(&p).contains("cube: 1 property references"), "{}", notes(&p));
    // a reference into a color group is kept as it is
    let p = read_3mf(&cube_with(
        |m| {
            m.replace(
                "<m:texture2d ",
                r##"<m:colorgroup id="5"><m:color color="#FF0000"/></m:colorgroup><m:texture2d "##,
            )
            .replace(r#"p1="4""#, r#"pid="5" p1="0""#)
        },
        &[],
    ))
    .expect("reads");
    assert!(p.notes.is_empty(), "{:?}", p.notes);
    assert_eq!(p.objects[0].parts[0].props.of(2), Some((5, [0, 0, 0])));
}

#[test]
fn json_operation_gives_texture_coordinates_as_buffers() {
    let bytes = file(CUBE);
    let load = |_: &str| -> sx_geom::Result<Vec<u8>> { Ok(bytes.clone()) };
    let out = sx_geom::json::call_with_files("format.read3mf", r#"{"data":{"path":"mem:0"}}"#, &load)
        .expect("reads");
    let v: serde_json::Value = serde_json::from_str(&out).expect("json");
    let image = &v["textures"]["images"][0];
    assert_eq!(image["path"], "3D/Texture/checker.png");
    assert_eq!(image["contentType"], "image/png");
    let group = &v["textures"]["groups"][0];
    assert_eq!(
        (group["id"].as_u64(), group["count"].as_u64()),
        (Some(2), Some(8))
    );
    let props = &v["objects"][0]["parts"][0]["props"];
    assert_eq!(props["default"], serde_json::json!([2, 7]));
    let buffers = sx_geom::json::take_out_files();
    let at = |x: &serde_json::Value| usize::try_from(x["rawBytes"].as_u64().expect("buffer")).expect("index");
    let refs = buffers[at(&props["refs"])].to_bytes();
    // a count, then five u32 per triangle that names its own
    assert_eq!(refs.len(), 4 + 3 * 20);
    assert_eq!(refs[..4], 3u32.to_le_bytes());
    let uvs = buffers[at(&group["uvs"])].to_bytes();
    assert_eq!(uvs.len(), 8 * 8);
    assert_eq!(uvs[8..12], 1.0f32.to_le_bytes());
}
