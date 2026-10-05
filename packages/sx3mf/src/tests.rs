// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Unit tests. Every package is built in code.

use std::io::{Cursor, Read, Write};

use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

use crate::*;

const OLD_NAMESPACE: &str = "https://slicerx.app/schemas/vault/2026";

const PLAIN_MODEL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<model unit=\"millimeter\" xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\">\n  \
<metadata name=\"Title\">Owl</metadata>\n  <metadata name=\"Designer\">Someone</metadata>\n  \
<metadata name=\"Application\">BambuStudio-02.03.00.70</metadata>\n  \
<resources>\n    <object id=\"1\" type=\"model\"><mesh><vertices/><triangles/></mesh></object>\n  \
</resources>\n  <build><item objectid=\"1\"/></build>\n</model>\n";

const CONTENT_TYPES: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\n  \
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\n  \
<Default Extension=\"model\" ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/>\n\
</Types>\n";

const RELS: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n  \
<Relationship Target=\"/3D/3dmodel.model\" Id=\"rel-1\" Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\"/>\n\
</Relationships>\n";

const SETTINGS: &[u8] = b"; plate settings kept byte for byte\n";

fn sample_meta() -> Sx3mfMetadata {
    Sx3mfMetadata {
        listing: Some("lst_01J0000000000000000000TEST".to_owned()),
        version: Some("1.2.0".to_owned()),
        version_id: Some("ver_01J0000000000000000000TEST".to_owned()),
        creator: Some("crt_example".to_owned()),
        exported_by: Some("usr_opaque_reference".to_owned()),
    }
}

fn png() -> Vec<u8> {
    let mut v = b"\x89PNG\r\n\x1a\n".to_vec();
    v.extend_from_slice(b"not a real image, the crate never decodes it");
    v
}

fn build(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, data) in entries {
        w.start_file(*name, SimpleFileOptions::default()).unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

fn plain_3mf(model: &str) -> Vec<u8> {
    build(&[
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", RELS.as_bytes()),
        ("3D/3dmodel.model", model.as_bytes()),
        ("Metadata/project_settings.config", SETTINGS),
    ])
}

fn entries(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut z = ZipArchive::new(Cursor::new(bytes)).unwrap();
    (0..z.len())
        .map(|i| {
            let mut f = z.by_index(i).unwrap();
            let mut d = Vec::new();
            f.read_to_end(&mut d).unwrap();
            (f.name().to_owned(), d)
        })
        .collect()
}

fn part_text(bytes: &[u8], name: &str) -> String {
    let (_, d) = entries(bytes).into_iter().find(|(n, _)| n == name).unwrap();
    String::from_utf8(d).unwrap()
}

fn raw_entry(bytes: &[u8], name: &str) -> (u32, u64, u64) {
    let mut z = ZipArchive::new(Cursor::new(bytes)).unwrap();
    let f = z.by_name(name).unwrap();
    (f.crc32(), f.compressed_size(), f.size())
}

#[test]
fn a_plain_3mf_is_not_an_sx3mf() {
    let info = inspect(&plain_3mf(PLAIN_MODEL)).unwrap();
    assert!(!info.is_sx3mf);
    assert_eq!(info.model_part, "/3D/3dmodel.model");
    assert_eq!(info.title.as_deref(), Some("Owl"));
    assert_eq!(info.designer.as_deref(), Some("Someone"));
    assert_eq!(info.application.as_deref(), Some("BambuStudio-02.03.00.70"));
    assert!(info.metadata.is_empty());
    assert!(info.thumbnail_png.is_none());
}

#[test]
fn stamp_round_trips_and_keeps_every_other_part() {
    let plain = plain_3mf(PLAIN_MODEL);
    let sx = stamp(&plain, &sample_meta(), None).unwrap();
    let info = inspect(&sx).unwrap();
    assert!(info.is_sx3mf);
    assert_eq!(info.metadata, sample_meta());
    assert_eq!(info.title.as_deref(), Some("Owl"));
    let names: Vec<_> = entries(&sx).into_iter().map(|(n, _)| n).collect();
    assert_eq!(
        names,
        [
            "[Content_Types].xml",
            "_rels/.rels",
            "3D/3dmodel.model",
            "Metadata/project_settings.config"
        ]
    );
    for name in [
        "[Content_Types].xml",
        "_rels/.rels",
        "Metadata/project_settings.config",
    ] {
        assert_eq!(raw_entry(&sx, name), raw_entry(&plain, name), "{name}");
    }
    // The geometry is the same text; only the sx entries were added.
    let model = part_text(&sx, "3D/3dmodel.model");
    assert!(model.contains("<build><item objectid=\"1\"/></build>"));
    assert!(model.contains(&format!("xmlns:sx=\"{NAMESPACE}\"")));
    // Stamping again with the same metadata gives the same bytes.
    assert_eq!(stamp(&sx, &sample_meta(), None).unwrap(), sx);
}

#[test]
fn stamp_replaces_entries_and_drops_unset_ones() {
    let sx = stamp(&plain_3mf(PLAIN_MODEL), &sample_meta(), None).unwrap();
    let library = Sx3mfMetadata {
        listing: Some("lst_2".to_owned()),
        creator: Some("crt_2".to_owned()),
        ..Sx3mfMetadata::default()
    };
    let again = stamp(&sx, &library, None).unwrap();
    let info = inspect(&again).unwrap();
    assert_eq!(info.metadata, library);
    assert!(!part_text(&again, "3D/3dmodel.model").contains("usr_opaque_reference"));
}

#[test]
fn stamp_adds_or_replaces_the_thumbnail() {
    let sx = stamp(&plain_3mf(PLAIN_MODEL), &sample_meta(), Some(&png())).unwrap();
    let info = inspect(&sx).unwrap();
    assert_eq!(info.thumbnail_png.as_deref(), Some(png().as_slice()));
    let types = part_text(&sx, "[Content_Types].xml");
    assert_eq!(types.matches("Extension=\"png\"").count(), 1);
    let rels = part_text(&sx, "_rels/.rels");
    assert!(rels.contains("Id=\"rel-1\""));
    assert!(rels.contains(&format!("Type=\"{THUMBNAIL_REL}\" Target=\"{THUMBNAIL_PART}\"")));

    // A second stamp replaces the picture instead of adding another.
    let mut other = png();
    other.push(1);
    let again = stamp(&sx, &sample_meta(), Some(&other)).unwrap();
    assert_eq!(inspect(&again).unwrap().thumbnail_png, Some(other));
    let names: Vec<_> = entries(&again).into_iter().map(|(n, _)| n).collect();
    assert_eq!(names.iter().filter(|n| *n == "Metadata/thumbnail.png").count(), 1);
    assert_eq!(part_text(&again, "_rels/.rels").matches(THUMBNAIL_REL).count(), 1);
    assert_eq!(
        part_text(&again, "[Content_Types].xml")
            .matches("Extension=\"png\"")
            .count(),
        1
    );

    let big = vec![0u8; usize::try_from(MAX_THUMBNAIL_BYTES).unwrap() + 1];
    assert!(matches!(
        stamp(&sx, &sample_meta(), Some(&big)),
        Err(Error::PartTooLarge { .. })
    ));
}

#[test]
fn an_earlier_sx_binding_is_rebound() {
    let old = PLAIN_MODEL.replace(
        "<model unit",
        &format!("<model xmlns:sx=\"{OLD_NAMESPACE}\" unit"),
    );
    let out = write_metadata(&old, &sample_meta()).unwrap();
    assert!(!out.contains(OLD_NAMESPACE));
    assert_eq!(out.matches("xmlns:sx").count(), 1);
    assert!(out.contains(&format!("xmlns:sx=\"{NAMESPACE}\"")));
}

#[test]
fn write_metadata_inserts_into_plain_model() {
    let meta = Sx3mfMetadata {
        listing: Some("lst_1".to_owned()),
        exported_by: Some(String::new()),
        ..Sx3mfMetadata::default()
    };
    let out = write_metadata(PLAIN_MODEL, &meta).unwrap();
    assert!(out.contains(&format!("xmlns:sx=\"{NAMESPACE}\"")));
    assert!(out.contains("<metadata name=\"sx:Listing\">lst_1</metadata>"));
    assert!(out.contains("<metadata name=\"sx:ExportedBy\"></metadata>"));
    assert!(!out.contains("sx:Creator"));
    let title = out.find("name=\"Title\"").unwrap();
    let sx = out.find("sx:Listing").unwrap();
    let resources = out.find("<resources>").unwrap();
    assert!(title < sx && sx < resources);
    xml::parse("model", &out).unwrap();
}

#[test]
fn write_metadata_replaces_and_is_idempotent() {
    let first = Sx3mfMetadata {
        listing: Some("lst_1".to_owned()),
        exported_by: Some("usr_1".to_owned()),
        ..Sx3mfMetadata::default()
    };
    let second = Sx3mfMetadata {
        listing: Some("lst_2 & <more>".to_owned()),
        version: Some("2.0.0".to_owned()),
        ..Sx3mfMetadata::default()
    };
    let once = write_metadata(PLAIN_MODEL, &first).unwrap();
    let replaced = write_metadata(&once, &second).unwrap();
    assert!(!replaced.contains("lst_1"));
    assert!(!replaced.contains("sx:ExportedBy"));
    assert!(replaced.contains("lst_2 &amp; &lt;more&gt;"));
    assert_eq!(replaced.matches("name=\"sx:Listing\"").count(), 1);
    assert!(replaced.contains("name=\"Designer\""));
    assert_eq!(write_metadata(&replaced, &second).unwrap(), replaced);
    assert_eq!(write_metadata(&once, &first).unwrap(), once);
}

#[test]
fn special_characters_round_trip_through_a_package() {
    let nasty = "Tom & Jerry <\"quoted\"> 'x' > done";
    let meta = Sx3mfMetadata {
        listing: Some(nasty.to_owned()),
        ..Sx3mfMetadata::default()
    };
    let sx = stamp(&plain_3mf(PLAIN_MODEL), &meta, None).unwrap();
    assert_eq!(inspect(&sx).unwrap().metadata.listing.as_deref(), Some(nasty));
    assert!(!part_text(&sx, "3D/3dmodel.model").contains("Tom & Jerry"));
}

#[test]
fn control_characters_in_values_are_rejected() {
    let meta = Sx3mfMetadata {
        creator: Some("a\nb".to_owned()),
        ..Sx3mfMetadata::default()
    };
    assert!(matches!(
        write_metadata(PLAIN_MODEL, &meta),
        Err(Error::InvalidValue { .. })
    ));
}

#[test]
fn doctype_and_custom_entities_are_rejected() {
    let doctype = "<!DOCTYPE model [<!ENTITY x \"y\">]>";
    let with_doctype = PLAIN_MODEL.replace("<model", &format!("{doctype}<model"));
    assert!(matches!(
        inspect(&plain_3mf(&with_doctype)).unwrap_err(),
        Error::ForbiddenXml { .. }
    ));
    assert!(matches!(
        write_metadata(&with_doctype, &Sx3mfMetadata::default()),
        Err(Error::ForbiddenXml { .. })
    ));
    let entity = PLAIN_MODEL.replace(">Owl<", ">&custom;<");
    assert!(inspect(&plain_3mf(&entity)).is_err());
    let rels = RELS.replace("<Relationships", &format!("{doctype}<Relationships"));
    let bad = build(&[
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", rels.as_bytes()),
        ("3D/3dmodel.model", PLAIN_MODEL.as_bytes()),
    ]);
    assert!(matches!(inspect(&bad).unwrap_err(), Error::ForbiddenXml { .. }));
}

#[test]
fn path_traversal_is_rejected() {
    for name in ["../evil.txt", "a/../../b", "/abs.txt", "dir\\file", "a//b"] {
        let bad = build(&[
            ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
            ("_rels/.rels", RELS.as_bytes()),
            ("3D/3dmodel.model", PLAIN_MODEL.as_bytes()),
            (name, b"x"),
        ]);
        assert!(
            matches!(inspect(&bad).unwrap_err(), Error::UnsafePartName(_)),
            "{name}"
        );
        assert!(matches!(
            stamp(&bad, &sample_meta(), None).unwrap_err(),
            Error::UnsafePartName(_)
        ));
    }
    let rels = RELS.replace("/3D/3dmodel.model", "/3D/../../etc/passwd");
    let bad = build(&[
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", rels.as_bytes()),
        ("3D/3dmodel.model", PLAIN_MODEL.as_bytes()),
    ]);
    assert!(matches!(inspect(&bad).unwrap_err(), Error::UnsafePartName(_)));
}

#[test]
fn too_many_entries_are_rejected() {
    let names: Vec<String> = (0..=MAX_ENTRIES).map(|i| format!("Extra/{i}.txt")).collect();
    let mut all: Vec<(&str, &[u8])> = vec![
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", RELS.as_bytes()),
        ("3D/3dmodel.model", PLAIN_MODEL.as_bytes()),
    ];
    all.extend(names.iter().map(|n| (n.as_str(), &b""[..])));
    assert!(matches!(
        inspect(&build(&all)).unwrap_err(),
        Error::TooManyEntries { max: MAX_ENTRIES, .. }
    ));
}

#[test]
fn inspect_reads_only_the_start_of_a_large_model() {
    let filler = "<object id=\"9\" type=\"model\"/>".repeat(100_000);
    let big = PLAIN_MODEL.replace("<resources>", &format!("<resources>{filler}"));
    assert!(u64::try_from(big.len()).unwrap() > MAX_METADATA_BYTES);
    let sx = stamp(&plain_3mf(&big), &sample_meta(), None).unwrap();
    assert_eq!(inspect(&sx).unwrap().metadata, sample_meta());

    // Metadata that never ends is refused rather than read without limit.
    let endless = "x".repeat(usize::try_from(MAX_METADATA_BYTES).unwrap());
    let long = PLAIN_MODEL.replace(">Owl<", &format!(">{endless}<"));
    assert!(matches!(
        inspect(&plain_3mf(&long)).unwrap_err(),
        Error::Malformed { .. }
    ));
}

#[test]
fn relative_targets_and_external_relationships() {
    let rels = format!(
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"a\" Type=\"{THUMBNAIL_REL}\" Target=\"https://evil.example/x.png\" TargetMode=\"External\"/>\
<Relationship Id=\"b\" Type=\"{MODEL_REL}\" Target=\"3D/3dmodel.model\"/></Relationships>"
    );
    let pkg = build(&[
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", rels.as_bytes()),
        ("3D/3dmodel.model", PLAIN_MODEL.as_bytes()),
    ]);
    let info = inspect(&pkg).unwrap();
    assert_eq!(info.model_part, "/3D/3dmodel.model");
    assert!(info.thumbnail_png.is_none());
    // Stamping a thumbnail drops the external one.
    let sx = stamp(&pkg, &sample_meta(), Some(&png())).unwrap();
    assert!(!part_text(&sx, "_rels/.rels").contains("evil.example"));
}

#[test]
fn a_thumbnail_relationship_to_nothing_is_ignored() {
    let rels = RELS.replace(
        "</Relationships>",
        &format!("<Relationship Id=\"t\" Type=\"{THUMBNAIL_REL}\" Target=\"/Metadata/plate_1.png\"/></Relationships>"),
    );
    let pkg = build(&[
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", rels.as_bytes()),
        ("3D/3dmodel.model", PLAIN_MODEL.as_bytes()),
    ]);
    let sx = stamp(&pkg, &sample_meta(), None).unwrap();
    let info = inspect(&sx).unwrap();
    assert!(info.is_sx3mf);
    assert!(info.thumbnail_png.is_none());
}

#[test]
fn missing_model_is_an_error() {
    let pkg = build(&[
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", RELS.as_bytes()),
    ]);
    assert!(matches!(inspect(&pkg).unwrap_err(), Error::MissingPart(_)));
}

#[test]
fn json_matches_the_typescript_contract() {
    let sx = stamp(&plain_3mf(PLAIN_MODEL), &sample_meta(), Some(&png())).unwrap();
    let info = inspect(&sx).unwrap();
    let json = serde_json::to_value(&info).unwrap();
    assert!(json.get("thumbnailPng").is_none());
    assert_eq!(json["isSx3mf"], true);
    assert_eq!(json["modelPart"], "/3D/3dmodel.model");
    assert_eq!(json["versionId"], "ver_01J0000000000000000000TEST");
    assert_eq!(json["exportedBy"], "usr_opaque_reference");
    let plain = serde_json::to_value(inspect(&plain_3mf(PLAIN_MODEL)).unwrap()).unwrap();
    assert!(plain.get("listing").is_none());
}

/// Writes the shared fixture that mirrors `packages/contracts/src/sx3mf.ts`.
#[test]
fn write_contract_fixture() {
    let sx = stamp(&plain_3mf(PLAIN_MODEL), &sample_meta(), Some(&png())).unwrap();
    let mut json = serde_json::to_string_pretty(&inspect(&sx).unwrap()).unwrap();
    json.push('\n');
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../contracts/fixtures/sx3mf-info.json"
    );
    std::fs::write(path, json).unwrap();
}
