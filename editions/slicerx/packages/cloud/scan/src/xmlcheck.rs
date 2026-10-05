// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! XML checks for the parts of a 3MF: UTF-8 only, no DOCTYPE, no entities
//! beyond the five predefined ones and character references, bounded nesting.
//! That closes external entity reads and entity expansion bombs before any
//! other parser sees the text.

use std::collections::HashSet;

use quick_xml::XmlVersion;
use quick_xml::escape::resolve_predefined_entity;
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, Writer};

/// Decodes the bytes as UTF-8 text, skipping a UTF-8 byte order mark.
fn utf8(bytes: &[u8]) -> Result<&str, String> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        return Err("UTF-16 XML is not accepted".into());
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf][..]).unwrap_or(bytes);
    std::str::from_utf8(bytes).map_err(|_| "not valid UTF-8".to_owned())
}

fn check_ref(r: &quick_xml::events::BytesRef<'_>) -> Result<(), String> {
    if r.resolve_char_ref().map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    let name = r.borrow().into_inner();
    if resolve_predefined_entity(&name).is_some() {
        Ok(())
    } else {
        Err("uses a custom entity".into())
    }
}

/// Checks that `bytes` is well formed and safe XML with one root element.
pub fn validate(bytes: &[u8], max_depth: usize) -> Result<(), String> {
    let text = utf8(bytes)?;
    let mut reader = Reader::from_str(text);
    let mut depth = 0usize;
    let mut roots = 0usize;
    loop {
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(_) => {
                if depth == 0 {
                    roots += 1;
                }
                depth += 1;
                if depth > max_depth {
                    return Err("elements are nested too deeply".into());
                }
            }
            Event::Empty(_) => {
                if depth == 0 {
                    roots += 1;
                }
            }
            Event::End(_) => depth = depth.saturating_sub(1),
            Event::GeneralRef(r) => check_ref(&r)?,
            Event::DocType(_) => return Err("has a DOCTYPE".into()),
            Event::Decl(d) => {
                if let Some(enc) = d.encoding() {
                    let enc = enc.map_err(|e| e.to_string())?;
                    if !enc.eq_ignore_ascii_case("utf-8") {
                        return Err("declares an encoding other than UTF-8".into());
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if roots != 1 || depth != 0 {
        return Err("does not have exactly one root element".into());
    }
    Ok(())
}

fn attr(e: &BytesStart<'_>, key: &str) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == key)
        .and_then(|a| {
            a.normalized_value(XmlVersion::Implicit1_0)
                .ok()
                .map(std::borrow::Cow::into_owned)
        })
}

/// Every `ContentType` value declared by `[Content_Types].xml`.
pub fn content_types(bytes: &[u8]) -> Result<Vec<String>, String> {
    let mut reader = Reader::from_str(utf8(bytes)?);
    let mut out = Vec::new();
    loop {
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(e) | Event::Empty(e) => {
                if let Some(t) = attr(&e, "ContentType") {
                    out.push(t);
                }
            }
            Event::Eof => return Ok(out),
            _ => {}
        }
    }
}

/// Resolves a relationship target to an entry name without a leading slash,
/// or `None` when it leaves the package.
fn resolve_target(dir: &str, target: &str) -> Option<String> {
    let joined = if let Some(abs) = target.strip_prefix('/') {
        abs.to_owned()
    } else if dir.is_empty() {
        target.to_owned()
    } else {
        format!("{dir}/{target}")
    };
    let mut parts = Vec::new();
    for seg in joined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

/// Rewrites a `.rels` part: external relationships and relationships that
/// point at removed parts are dropped. `dir` is the directory that holds the
/// `_rels` folder, and `removed` holds lowercase entry names.
pub fn rewrite_rels(bytes: &[u8], dir: &str, removed: &HashSet<String>) -> Result<Vec<u8>, String> {
    let mut reader = Reader::from_str(utf8(bytes)?);
    let mut writer = Writer::new(Vec::new());
    let mut skipping = 0usize;
    let drop_it = |e: &BytesStart<'_>| {
        if e.local_name().as_ref() != "Relationship" {
            return false;
        }
        if attr(e, "TargetMode").is_some_and(|m| m.eq_ignore_ascii_case("external")) {
            return true;
        }
        match attr(e, "Target").and_then(|t| resolve_target(dir, &t)) {
            Some(name) => removed.contains(&name.to_ascii_lowercase()),
            None => true,
        }
    };
    loop {
        let ev = reader.read_event().map_err(|e| e.to_string())?;
        match ev {
            Event::Eof => break,
            Event::Start(ref e) if skipping > 0 || drop_it(e) => skipping += 1,
            Event::End(_) if skipping > 0 => skipping -= 1,
            Event::Empty(ref e) if skipping == 0 && drop_it(e) => {}
            _ if skipping > 0 => {}
            Event::Comment(_) | Event::PI(_) | Event::DocType(_) => {}
            other => writer.write_event(other).map_err(|e| e.to_string())?,
        }
    }
    Ok(writer.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_xml_and_predefined_entities() {
        assert!(
            validate(
                b"<?xml version=\"1.0\" encoding=\"UTF-8\"?><a x=\"&amp;&#65;\"><b/>&lt;</a>",
                8
            )
            .is_ok()
        );
        assert!(validate(b"\xef\xbb\xbf<a/>", 8).is_ok());
    }

    #[test]
    fn refuses_the_dangerous_forms() {
        assert!(validate(b"<!DOCTYPE a><a/>", 8).is_err());
        assert!(validate(b"<a>&x;</a>", 8).is_err());
        assert!(validate(b"<a><b></a>", 8).is_err());
        assert!(validate(b"<a/><b/>", 8).is_err());
        assert!(validate(b"", 8).is_err());
        assert!(validate(b"\xff\xfe<\0a\0/\0>\0", 8).is_err());
        assert!(validate(b"<a><a><a/></a></a>", 1).is_err());
        assert!(validate(b"\xff\xfe\xfd", 8).is_err());
    }

    #[test]
    fn rels_rewrite_drops_removed_and_external_targets() {
        let rels = br#"<Relationships xmlns="x"><Relationship Id="1" Target="/3D/m.model"/><Relationship Id="2" Target="../Metadata/t.png"/><Relationship Id="3" Target="http://e/x" TargetMode="External"/></Relationships>"#;
        let removed: HashSet<String> = ["metadata/t.png".to_owned()].into();
        let out = String::from_utf8(rewrite_rels(rels, "3D", &removed).unwrap()).unwrap();
        assert!(out.contains("m.model"));
        assert!(!out.contains("t.png"));
        assert!(!out.contains("http://e"));
    }
}
