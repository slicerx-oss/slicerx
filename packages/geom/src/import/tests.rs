// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

#![allow(
    clippy::cast_possible_truncation,
    clippy::float_cmp,
    clippy::format_push_string
)]

use super::*;

pub(super) fn zip(entries: &[(&str, &[u8], bool)]) -> Vec<u8> {
    let crc = |d: &[u8]| {
        let mut c = 0xFFFF_FFFFu32;
        for &b in d {
            c ^= u32::from(b);
            for _ in 0..8 {
                c = if c & 1 == 1 {
                    (c >> 1) ^ 0xEDB8_8320
                } else {
                    c >> 1
                };
            }
        }
        !c
    };
    let mut out = Vec::new();
    let mut dir = Vec::new();
    for (name, data, deflate) in entries {
        let packed = if *deflate {
            miniz_oxide::deflate::compress_to_vec(data, 6)
        } else {
            data.to_vec()
        };
        let method: u16 = if *deflate { 8 } else { 0 };
        let offset = out.len() as u32;
        let header = |out: &mut Vec<u8>, central: bool| {
            out.extend_from_slice(if central { b"PK\x01\x02" } else { b"PK\x03\x04" });
            if central {
                out.extend_from_slice(&20u16.to_le_bytes());
            }
            out.extend_from_slice(&20u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&[0; 4]);
            out.extend_from_slice(&crc(data).to_le_bytes());
            out.extend_from_slice(&(packed.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            if central {
                out.extend_from_slice(&[0; 10]);
                out.extend_from_slice(&offset.to_le_bytes());
            }
            out.extend_from_slice(name.as_bytes());
        };
        header(&mut out, false);
        out.extend_from_slice(&packed);
        header(&mut dir, true);
    }
    let start = out.len() as u32;
    out.extend_from_slice(&dir);
    out.extend_from_slice(b"PK\x05\x06\0\0\0\0");
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(dir.len() as u32).to_le_bytes());
    out.extend_from_slice(&start.to_le_bytes());
    out.extend_from_slice(&[0; 2]);
    out
}

fn box_obj(first: usize, lo: f64, hi: f64, color: Option<[f64; 3]>) -> String {
    let mut s = String::new();
    for i in 0..8 {
        let p = |b: usize| if (i >> b) & 1 == 1 { hi } else { lo };
        s += &format!("v {} {} {}", p(0), p(1), p(2));
        if let Some(c) = color {
            let [r, g, b] = c;
            s += &format!(" {r} {g} {b}");
        }
        s += "\n";
    }
    let f = |a: usize, b: usize, c: usize, d: usize| {
        format!("f {} {} {} {}\n", first + a, first + b, first + c, first + d)
    };
    s + &f(0, 2, 3, 1) + &f(4, 5, 7, 6) + &f(0, 1, 5, 4) + &f(2, 6, 7, 3) + &f(0, 4, 6, 2) + &f(1, 3, 7, 5)
}

fn opts() -> ImportOptions {
    ImportOptions::default()
}

#[test]
fn obj_quads_become_watertight_triangles() {
    let m = import_obj(box_obj(1, 0.0, 10.0, None).as_bytes(), "box.obj", None, &opts()).unwrap();
    assert_eq!(m.parts.len(), 1);
    assert_eq!(m.parts[0].mesh.triangles.len(), 12);
    assert!(m.slot_colors.is_empty() && m.parts[0].color.is_none());
    let mesh = &m.parts[0].mesh;
    assert!(mesh.edge_report().is_watertight(), "{:?}", mesh.edge_report());
    assert!((mesh.volume().abs() - 1000.0).abs() < 1e-9);
    assert!(!m.multi_body());
    assert_eq!(m.unit.confidence, Confidence::None);
}

#[test]
fn obj_negative_indices_and_slashes() {
    let obj = "v 0 0 0\nv 10 0 0\nv 10 10 0\nv 0 10 0\nv 0 0 10\nf -4/1/1 -3//2 -2 -1\nf 1/1 2/1 5/1\n";
    let m = import_obj(obj.as_bytes(), "x.obj", None, &opts()).unwrap();
    assert_eq!(m.parts[0].mesh.triangles.len(), 3);
    assert!(import_obj(b"v 0 0 0\nf 1 2 9\n", "x.obj", None, &opts()).is_err());
    assert!(import_obj(b"v 0 0\n", "x.obj", None, &opts()).is_err());
    assert!(import_obj(b"v 0 0 0\n", "x.obj", None, &opts()).is_err());
}

#[test]
fn obj_vertex_colors_map_to_slots() {
    let obj = box_obj(1, 0.0, 10.0, Some([1.0, 0.0, 0.0])) + &box_obj(9, 20.0, 30.0, Some([0.0, 0.0, 1.0]));
    let m = import_obj(obj.as_bytes(), "two.obj", None, &opts()).unwrap();
    assert_eq!(m.slot_colors, vec!["#ff0000", "#0000ff"]);
    assert_eq!(m.parts.len(), 2);
    assert_eq!((m.parts[0].slot, m.parts[1].slot), (1, 2));
    assert_eq!(m.parts[1].color.as_deref(), Some("#0000ff"));
    assert!(!m.multi_body());
}

#[test]
fn obj_materials_come_from_the_mtl_loader() {
    let obj = format!(
        "mtllib m.mtl\nusemtl red\n{}usemtl green\n{}",
        box_obj(1, 0.0, 10.0, None),
        box_obj(9, 20.0, 30.0, None)
    );
    let mtl = "newmtl red\nKd 0.8 0.1 0.1\nnewmtl green\nKd 0 1 0\n";
    let loader = |n: &str| (n == "m.mtl").then(|| mtl.as_bytes().to_vec());
    let m = import_obj(obj.as_bytes(), "m.obj", Some(&loader), &opts()).unwrap();
    assert_eq!(m.slot_colors, vec!["#cc1a1a", "#00ff00"]);
    assert_eq!(m.parts.len(), 2);
    let bare = import_obj(obj.as_bytes(), "m.obj", None, &opts()).unwrap();
    assert!(bare.slot_colors.is_empty());
    assert!(bare.warnings.iter().any(|w| w.contains("m.mtl")));
}

#[test]
fn obj_objects_are_bodies_and_split_into_objects() {
    let obj = format!(
        "o left\n{}o right\n{}",
        box_obj(1, 0.0, 10.0, None),
        box_obj(9, 20.0, 30.0, None)
    );
    let m = import_obj(obj.as_bytes(), "two.obj", None, &opts()).unwrap();
    assert!(m.multi_body());
    assert_eq!(
        m.bodies.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(),
        ["left", "right"]
    );
    assert_eq!(m.bodies[0].size, [10.0; 3]);
    let objs = m.clone().into_objects();
    assert_eq!(objs.len(), 2);
    assert_eq!(objs[1].name, "right");
    assert_eq!(objs[1].parts.len(), 1);
    assert!(!objs[1].multi_body());
    assert_eq!(m.merged().triangles.len(), 24);
    let g = format!(
        "g a\n{}g b\n{}",
        box_obj(1, 0.0, 10.0, None),
        box_obj(9, 20.0, 30.0, None)
    );
    assert!(
        import_obj(g.as_bytes(), "g.obj", None, &opts())
            .unwrap()
            .multi_body()
    );
    let og = format!(
        "o body\ng a\n{}g b\n{}",
        box_obj(1, 0.0, 10.0, None),
        box_obj(9, 20.0, 30.0, None)
    );
    let m = import_obj(og.as_bytes(), "og.obj", None, &opts()).unwrap();
    assert!(!m.multi_body());
    assert_eq!(m.parts.len(), 2);
}

#[test]
fn too_many_colors_merge_to_the_limit() {
    let mut obj = String::new();
    for i in 0..30usize {
        let c = i as f64 / 29.0;
        obj += &box_obj(
            1 + 8 * i,
            i as f64 * 20.0,
            i as f64 * 20.0 + 10.0,
            Some([c, 1.0 - c, 0.5]),
        );
    }
    let o = ImportOptions {
        max_colors: 4,
        ..opts()
    };
    let m = import_obj(obj.as_bytes(), "many.obj", None, &o).unwrap();
    assert_eq!(m.slot_colors.len(), 4);
    assert!(m.parts.iter().all(|p| (1..=4).contains(&p.slot)));
    assert_eq!(
        m.parts.iter().map(|p| p.mesh.triangles.len()).sum::<usize>(),
        30 * 12
    );
    let mut used: Vec<u8> = m.parts.iter().map(|p| p.slot).collect();
    used.dedup();
    used.sort_unstable();
    used.dedup();
    assert_eq!(used, vec![1, 2, 3, 4]);
}

#[test]
fn units_are_guessed_from_size() {
    let inch = detect_unit(2.0);
    assert_eq!((inch.detected, inch.confidence), (Unit::Inch, Confidence::Low));
    assert!((inch.suggested_scale - 25.4).abs() < 1e-12);
    let meter = detect_unit(0.12);
    assert_eq!(
        (meter.detected, meter.confidence),
        (Unit::Meter, Confidence::High)
    );
    assert_eq!(meter.suggested_scale, 1000.0);
    assert_eq!(detect_unit(60.0).confidence, Confidence::None);
    assert_eq!(detect_unit(0.0).detected, Unit::Millimeter);
    let m = import_obj(box_obj(1, 0.0, 2.0, None).as_bytes(), "s.obj", None, &opts()).unwrap();
    assert_eq!(m.unit.detected, Unit::Inch);
    assert!((m.merged().bounds().unwrap().size()[0] - 2.0).abs() < 1e-12);
    let s = m.scaled(25.4);
    assert!((s.merged().bounds().unwrap().size()[0] - 50.8).abs() < 1e-9);
    assert!((s.bodies[0].size[0] - 50.8).abs() < 1e-9);
}

const AMF: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<amf unit="inch" version="1.1">
 <metadata type="name">test</metadata>
 <object id="0">
  <metadata type="name">Cube</metadata>
  <mesh>
   <vertices>
    <vertex><coordinates><x>0</x><y>0</y><z>0</z></coordinates></vertex>
    <vertex><coordinates><x>1</x><y>0</y><z>0</z></coordinates></vertex>
    <vertex><coordinates><x>1</x><y>1</y><z>0</z></coordinates></vertex>
    <vertex><coordinates><x>0</x><y>1</y><z>0</z></coordinates></vertex>
    <vertex><coordinates><x>0</x><y>0</y><z>1</z></coordinates></vertex>
    <vertex><coordinates><x>1</x><y>0</y><z>1</z></coordinates></vertex>
    <vertex><coordinates><x>1</x><y>1</y><z>1</z></coordinates></vertex>
    <vertex><coordinates><x>0</x><y>1</y><z>1</z></coordinates></vertex>
   </vertices>
   <volume materialid="1">
    <metadata type="name">bottom half</metadata>
    <triangle><v1>0</v1><v2>2</v2><v3>1</v3></triangle>
    <triangle><v1>0</v1><v2>3</v2><v3>2</v3></triangle>
    <triangle><v1>0</v1><v2>1</v2><v3>5</v3></triangle>
    <triangle><v1>0</v1><v2>5</v2><v3>4</v3></triangle>
    <triangle><v1>3</v1><v2>0</v2><v3>4</v3></triangle>
    <triangle><v1>3</v1><v2>4</v2><v3>7</v3></triangle>
   </volume>
   <volume>
    <triangle><v1>4</v1><v2>5</v2><v3>6</v3></triangle>
    <triangle><v1>4</v1><v2>6</v2><v3>7</v3></triangle>
    <triangle><v1>1</v1><v2>2</v2><v3>6</v3></triangle>
    <triangle><v1>1</v1><v2>6</v2><v3>5</v3></triangle>
    <triangle><v1>2</v1><v2>3</v2><v3>7</v3></triangle>
    <triangle><v1>2</v1><v2>7</v2><v3>6</v3></triangle>
    <triangle><v1>0</v1><v2>0</v2><v3>0</v3><color><r>0</r><g>1</g><b>0</b></color></triangle>
   </volume>
  </mesh>
 </object>
 <material id="1"><color><r>1</r><g>0</g><b>0</b></color></material>
</amf>"#;

#[test]
fn amf_units_volumes_and_colors() {
    let m = import_amf(AMF.as_bytes(), "c.amf", &opts()).unwrap();
    assert_eq!(m.unit.declared, Some(Unit::Inch));
    assert_eq!(m.unit.confidence, Confidence::Declared);
    assert_eq!(m.unit.suggested_scale, 1.0);
    assert!((m.merged().bounds().unwrap().size()[2] - 25.4).abs() < 1e-9);
    assert_eq!(m.bodies.len(), 1);
    assert_eq!(m.bodies[0].name, "Cube");
    assert_eq!(m.slot_colors, vec!["#ff0000", "#00ff00", "#808080"]);
    assert_eq!(m.parts.len(), 3);
    assert!(
        m.parts
            .iter()
            .any(|p| p.name.contains("bottom half") && p.slot == 1)
    );
}

#[test]
fn zipped_amf_and_multiple_objects() {
    let two = AMF.replace(
        "</amf>",
        " <object id=\"1\"><mesh><vertices>\
         <vertex><coordinates><x>0</x><y>0</y><z>0</z></coordinates></vertex>\
         <vertex><coordinates><x>1</x><y>0</y><z>0</z></coordinates></vertex>\
         <vertex><coordinates><x>0</x><y>1</y><z>0</z></coordinates></vertex>\
         <vertex><coordinates><x>0</x><y>0</y><z>1</z></coordinates></vertex>\
         </vertices><volume>\
         <triangle><v1>0</v1><v2>2</v2><v3>1</v3></triangle>\
         <triangle><v1>0</v1><v2>1</v2><v3>3</v3></triangle>\
         <triangle><v1>1</v1><v2>2</v2><v3>3</v3></triangle>\
         <triangle><v1>2</v1><v2>0</v2><v3>3</v3></triangle>\
         </volume></mesh></object></amf>",
    );
    let z = zip(&[("readme.txt", b"x", false), ("model.amf", two.as_bytes(), true)]);
    let m = import_amf(&z, "z.amf", &opts()).unwrap();
    assert!(m.multi_body());
    assert_eq!(m.bodies.len(), 2);
    assert_eq!(m.bodies[1].triangles, 4);
    assert!((m.bodies[1].size[0] - 25.4).abs() < 1e-9);
    let z = zip(&[("model.amf", two.as_bytes(), false)]);
    assert_eq!(import_amf(&z, "z.amf", &opts()).unwrap().bodies.len(), 2);
    assert!(import_amf(b"<amf></amf>", "e.amf", &opts()).is_err());
    assert!(import_amf(&zip(&[("a.txt", b"x", false)]), "z.amf", &opts()).is_err());
    let bad = AMF.replace("<amf unit=\"inch\"", "<amf unit=\"cubit\"");
    assert!(import_amf(bad.as_bytes(), "b.amf", &opts()).is_err());
}

#[test]
fn stl_shells_become_bodies() {
    let mut mesh = crate::build::box_mesh([0.0; 3], [10.0; 3]);
    let mut other = crate::build::box_mesh([0.0; 3], [5.0; 3]);
    other.translate([30.0, 0.0, 0.0]);
    mesh.append(&other);
    let stl = mesh.to_stl("t");
    let m = import_stl(&stl, "two.stl", &opts()).unwrap();
    assert!(m.multi_body());
    assert_eq!(m.bodies[0].triangles, 12);
    let one = import_stl(
        &stl,
        "two.stl",
        &ImportOptions {
            split_shells: false,
            ..opts()
        },
    )
    .unwrap();
    assert!(!one.multi_body());
}
