// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Reading and stamping the OPC zip package. Parts other than the root model,
//! the package relationships, the content types and the thumbnail are copied
//! byte for byte and never parsed.

use std::fmt::Write as _;
use std::io::{BufReader, Cursor, Read, Seek, Write};

use quick_xml::escape::escape;
use zip::result::ZipError;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::error::Error;
use crate::xml::{self, Element};
use crate::{MODEL_PART, MODEL_REL, Sx3mfInfo, Sx3mfMetadata, THUMBNAIL_PART, THUMBNAIL_REL};

/// Most entries a reader accepts in one package. Projects that keep one model
/// file per object need far more than a single-model 3MF.
pub const MAX_ENTRIES: usize = 10_000;
/// Largest uncompressed size of the content types and relationships parts.
pub const MAX_XML_PART_BYTES: u64 = 4 * 1024 * 1024;
/// Largest uncompressed size of the model part [`stamp`] rewrites in memory.
pub const MAX_MODEL_PART_BYTES: u64 = 1024 * 1024 * 1024;
/// How much of the model part [`inspect`] reads to find its leading metadata.
pub const MAX_METADATA_BYTES: u64 = 1024 * 1024;
/// Largest uncompressed size of the thumbnail.
pub const MAX_THUMBNAIL_BYTES: u64 = 8 * 1024 * 1024;

const CONTENT_TYPES_PART: &str = "/[Content_Types].xml";
const RELS_PART: &str = "/_rels/.rels";
const XML_DECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
const PNG_CONTENT_TYPE: &str = "image/png";

// ---------------------------------------------------------------- names

/// Checks a zip entry name or the part of a part name after the leading slash.
fn check_entry_name(name: &str) -> Result<(), Error> {
    let bad = || Error::UnsafePartName(name.to_owned());
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    if trimmed.is_empty() || trimmed.contains(['\\', ':']) || trimmed.chars().any(char::is_control) {
        return Err(bad());
    }
    if trimmed
        .split('/')
        .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return Err(bad());
    }
    Ok(())
}

/// Turns a part name such as `/3D/3dmodel.model` into the zip entry name.
/// Relationship targets may omit the leading slash; both forms are accepted.
fn zip_name(part: &str) -> Result<&str, Error> {
    let name = part.strip_prefix('/').unwrap_or(part);
    check_entry_name(name).map_err(|_| Error::UnsafePartName(part.to_owned()))?;
    Ok(name)
}

fn part_name(target: &str) -> String {
    if target.starts_with('/') {
        target.to_owned()
    } else {
        format!("/{target}")
    }
}

// -------------------------------------------------------------- reading

fn open<R: Read + Seek>(reader: R) -> Result<ZipArchive<R>, Error> {
    let archive = ZipArchive::new(reader)?;
    if archive.len() > MAX_ENTRIES {
        return Err(Error::TooManyEntries {
            count: archive.len(),
            max: MAX_ENTRIES,
        });
    }
    for name in archive.file_names() {
        check_entry_name(name)?;
    }
    Ok(archive)
}

fn read_part<R: Read + Seek>(archive: &mut ZipArchive<R>, part: &str, max: u64) -> Result<Vec<u8>, Error> {
    let name = zip_name(part)?;
    let file = match archive.by_name(name) {
        Ok(f) => f,
        Err(ZipError::FileNotFound) => return Err(Error::MissingPart(part.to_owned())),
        Err(e) => return Err(e.into()),
    };
    let too_large = || Error::PartTooLarge {
        part: part.to_owned(),
        max,
    };
    // The declared size can lie, so the read itself is capped too.
    if file.size() > max {
        return Err(too_large());
    }
    let mut buf = Vec::new();
    file.take(max.saturating_add(1)).read_to_end(&mut buf)?;
    if u64::try_from(buf.len()).unwrap_or(u64::MAX) > max {
        return Err(too_large());
    }
    Ok(buf)
}

fn utf8(part: &str, bytes: Vec<u8>) -> Result<String, Error> {
    String::from_utf8(bytes).map_err(|_| Error::Malformed {
        part: part.to_owned(),
        reason: "not valid UTF-8",
    })
}

fn read_xml<R: Read + Seek>(archive: &mut ZipArchive<R>, part: &str) -> Result<Element, Error> {
    let text = utf8(part, read_part(archive, part, MAX_XML_PART_BYTES)?)?;
    xml::parse(part, text.trim_start_matches('\u{feff}'))
}

/// One package relationship, attributes as written.
#[derive(Debug, Clone)]
struct Rel {
    attrs: Vec<(String, String)>,
}

impl Rel {
    fn get(&self, key: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

fn read_rels<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<Vec<Rel>, Error> {
    let root = read_xml(archive, RELS_PART)?;
    if root.name != "Relationships" {
        return Err(Error::Malformed {
            part: RELS_PART.to_owned(),
            reason: "root element is not Relationships",
        });
    }
    Ok(root
        .children_named("Relationship")
        .map(|r| Rel {
            attrs: r.attrs.clone(),
        })
        .collect())
}

fn internal_target<'a>(rels: &'a [Rel], rel_type: &str) -> Option<&'a str> {
    rels.iter()
        .filter(|r| r.get("TargetMode").is_none_or(|m| m != "External"))
        .find(|r| r.get("Type") == Some(rel_type))
        .and_then(|r| r.get("Target"))
}

fn model_part(rels: &[Rel]) -> Result<String, Error> {
    let target = internal_target(rels, MODEL_REL).ok_or_else(|| Error::MissingPart(MODEL_PART.to_owned()))?;
    let part = part_name(target);
    zip_name(&part)?;
    Ok(part)
}

/// Reads the `sx:` entries, the standard title, designer and application
/// entries and the package thumbnail of a 3MF or .sx3mf package. Only the
/// start of the model part is read, so the size of the geometry does not
/// matter. A plain 3MF is not an error: it reads with `is_sx3mf` false.
pub fn inspect(zip_bytes: &[u8]) -> Result<Sx3mfInfo, Error> {
    let mut archive = open(Cursor::new(zip_bytes))?;
    let rels = read_rels(&mut archive)?;
    let model_part = model_part(&rels)?;

    let head = {
        let file = match archive.by_name(zip_name(&model_part)?) {
            Ok(f) => f,
            Err(ZipError::FileNotFound) => return Err(Error::MissingPart(model_part)),
            Err(e) => return Err(e.into()),
        };
        // A model whose metadata runs past the cap reads as truncated XML.
        xml::read_model_head(&model_part, BufReader::new(file.take(MAX_METADATA_BYTES))).map_err(
            |e| match e {
                Error::Malformed { part, .. } if part == model_part => Error::Malformed {
                    part,
                    reason: "the model metadata is malformed or longer than the reader accepts",
                },
                other => other,
            },
        )?
    };

    // A thumbnail relationship that points at nothing is common in the wild
    // and costs only the picture.
    let thumbnail_png = match internal_target(&rels, THUMBNAIL_REL) {
        None => None,
        Some(target) => match read_part(&mut archive, &part_name(target), MAX_THUMBNAIL_BYTES) {
            Ok(png) => Some(png),
            Err(Error::MissingPart(_)) => None,
            Err(e) => return Err(e),
        },
    };

    Ok(Sx3mfInfo {
        is_sx3mf: head.binds_sx || head.any_sx_entry,
        model_part,
        metadata: head.meta,
        title: head.title,
        designer: head.designer,
        application: head.application,
        thumbnail_png,
    })
}

// -------------------------------------------------------------- writing

fn rels_xml(rels: &[Rel]) -> String {
    let mut out = format!(
        "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n"
    );
    for rel in rels {
        out.push_str("  <Relationship");
        for (k, v) in &rel.attrs {
            let _ = write!(out, " {k}=\"{}\"", escape(v));
        }
        out.push_str("/>\n");
    }
    out.push_str("</Relationships>\n");
    out
}

/// Points the package thumbnail relationship at [`THUMBNAIL_PART`], keeping
/// every other relationship.
fn rels_with_thumbnail(mut rels: Vec<Rel>) -> String {
    rels.retain(|r| r.get("Type") != Some(THUMBNAIL_REL));
    let mut n = 1usize;
    let id = loop {
        let id = format!("rel{n}");
        if !rels.iter().any(|r| r.get("Id") == Some(id.as_str())) {
            break id;
        }
        n += 1;
    };
    rels.push(Rel {
        attrs: vec![
            ("Id".to_owned(), id),
            ("Type".to_owned(), THUMBNAIL_REL.to_owned()),
            ("Target".to_owned(), THUMBNAIL_PART.to_owned()),
        ],
    });
    rels_xml(&rels)
}

/// Adds a `png` default to the content types unless one exists.
fn content_types_with_png(part: &str, text: &str) -> Result<Option<String>, Error> {
    let root = xml::parse(part, text.trim_start_matches('\u{feff}'))?;
    if root.name != "Types" {
        return Err(Error::Malformed {
            part: part.to_owned(),
            reason: "root element is not Types",
        });
    }
    let has_png = root
        .children_named("Default")
        .any(|d| d.attr("Extension").is_some_and(|e| e.eq_ignore_ascii_case("png")));
    if has_png {
        return Ok(None);
    }
    let close = text.rfind("</").ok_or(Error::Malformed {
        part: part.to_owned(),
        reason: "Types has no end tag",
    })?;
    let (before, after) = text.split_at(close);
    Ok(Some(format!(
        "{before}  <Default Extension=\"png\" ContentType=\"{PNG_CONTENT_TYPE}\"/>\n{after}"
    )))
}

fn options(method: CompressionMethod, len: usize) -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(method)
        .large_file(u64::try_from(len).unwrap_or(u64::MAX) >= u64::from(u32::MAX))
}

fn add_part<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    name: &str,
    method: CompressionMethod,
    data: &[u8],
) -> Result<(), Error> {
    zip.start_file(name, options(method, data.len()))?;
    zip.write_all(data)?;
    Ok(())
}

/// Turns a 3MF package into an .sx3mf: writes `meta` into the root model part
/// (see [`crate::write_metadata`]; existing `sx:` entries are replaced) and,
/// when `thumbnail_png` is given, stores it at [`THUMBNAIL_PART`] as the
/// package thumbnail. Every other part is copied unchanged, compressed bytes
/// included, so geometry, plates and settings stay exactly as they were.
pub fn stamp(zip_bytes: &[u8], meta: &Sx3mfMetadata, thumbnail_png: Option<&[u8]>) -> Result<Vec<u8>, Error> {
    if let Some(png) = thumbnail_png
        && u64::try_from(png.len()).unwrap_or(u64::MAX) > MAX_THUMBNAIL_BYTES
    {
        return Err(Error::PartTooLarge {
            part: THUMBNAIL_PART.to_owned(),
            max: MAX_THUMBNAIL_BYTES,
        });
    }
    let mut archive = open(Cursor::new(zip_bytes))?;
    let rels = read_rels(&mut archive)?;
    let model_part = model_part(&rels)?;
    let model = utf8(
        &model_part,
        read_part(&mut archive, &model_part, MAX_MODEL_PART_BYTES)?,
    )?;
    let model = xml::rewrite_model(model.trim_start_matches('\u{feff}'), meta)?;

    let model_entry = zip_name(&model_part)?.to_owned();
    let rels_entry = zip_name(RELS_PART)?;
    let types_entry = zip_name(CONTENT_TYPES_PART)?;
    let thumb_entry = zip_name(THUMBNAIL_PART)?;
    let (new_rels, new_types) = if thumbnail_png.is_some() {
        let types = utf8(
            CONTENT_TYPES_PART,
            read_part(&mut archive, CONTENT_TYPES_PART, MAX_XML_PART_BYTES)?,
        )?;
        (
            Some(rels_with_thumbnail(rels)),
            content_types_with_png(CONTENT_TYPES_PART, &types)?,
        )
    } else {
        (None, None)
    };

    let deflate = CompressionMethod::Deflated;
    let mut out = ZipWriter::new(Cursor::new(Vec::new()));
    for i in 0..archive.len() {
        let file = archive.by_index_raw(i)?;
        let name = file.name().to_owned();
        if name == model_entry {
            drop(file);
            add_part(&mut out, &name, deflate, model.as_bytes())?;
        } else if name == rels_entry && new_rels.is_some() {
            drop(file);
            add_part(
                &mut out,
                &name,
                deflate,
                new_rels.as_deref().unwrap_or_default().as_bytes(),
            )?;
        } else if name == types_entry && new_types.is_some() {
            drop(file);
            add_part(
                &mut out,
                &name,
                deflate,
                new_types.as_deref().unwrap_or_default().as_bytes(),
            )?;
        } else if name == thumb_entry && thumbnail_png.is_some() {
            // Replaced below.
        } else {
            out.raw_copy_file(file)?;
        }
    }
    if let Some(png) = thumbnail_png {
        add_part(&mut out, thumb_entry, CompressionMethod::Stored, png)?;
    }
    Ok(out.finish()?.into_inner())
}
