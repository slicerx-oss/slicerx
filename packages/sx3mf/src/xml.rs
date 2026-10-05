// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! XML reading into a small element tree, the streaming reader for the
//! model part's leading metadata, and the model metadata rewriter.

use std::io::{BufRead, Write};

use quick_xml::escape::{escape, resolve_predefined_entity};
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, Writer, XmlVersion};

use crate::NAMESPACE;
use crate::Sx3mfMetadata;
use crate::error::Error;

const MAX_DEPTH: usize = 32;

/// One element with its attributes, direct text and child elements.
/// Names are local names; attribute keys are kept as written.
#[derive(Debug, Default)]
pub(crate) struct Element {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub text: String,
    pub children: Vec<Element>,
}

impl Element {
    pub fn attr(&self, key: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Element> {
        self.children.iter().filter(move |c| c.name == name)
    }
}

fn xml_err(part: &str, source: impl Into<quick_xml::Error>) -> Error {
    Error::Xml {
        part: part.to_owned(),
        source: source.into(),
    }
}

fn malformed(part: &str, reason: &'static str) -> Error {
    Error::Malformed {
        part: part.to_owned(),
        reason,
    }
}

fn element_from(part: &str, e: &BytesStart<'_>) -> Result<Element, Error> {
    let name = e.local_name().as_ref().to_owned();
    let mut attrs = Vec::new();
    for attr in e.attributes() {
        let attr = attr.map_err(|err| xml_err(part, err))?;
        let value = attr
            .normalized_value(XmlVersion::Implicit1_0)
            .map_err(|err| xml_err(part, err))?;
        attrs.push((attr.key.as_ref().to_owned(), value.into_owned()));
    }
    Ok(Element {
        name,
        attrs,
        ..Element::default()
    })
}

fn attach(part: &str, stack: &mut [Element], root: &mut Option<Element>, el: Element) -> Result<(), Error> {
    if let Some(parent) = stack.last_mut() {
        parent.children.push(el);
    } else if root.is_none() {
        *root = Some(el);
    } else {
        return Err(malformed(part, "more than one root element"));
    }
    Ok(())
}

fn push_ref(part: &str, r: &quick_xml::events::BytesRef<'_>, out: &mut String) -> Result<(), Error> {
    if let Some(c) = r.resolve_char_ref().map_err(|e| xml_err(part, e))? {
        out.push(c);
        return Ok(());
    }
    let name = r.borrow().into_inner();
    match resolve_predefined_entity(&name) {
        Some(s) => {
            out.push_str(s);
            Ok(())
        }
        None => Err(Error::ForbiddenXml {
            part: part.to_owned(),
        }),
    }
}

/// Parses `xml` into an element tree. DOCTYPE and custom entities are refused.
pub(crate) fn parse(part: &str, xml: &str) -> Result<Element, Error> {
    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<Element> = Vec::new();
    let mut root: Option<Element> = None;
    loop {
        match reader.read_event().map_err(|e| xml_err(part, e))? {
            Event::Start(e) => {
                if stack.len() >= MAX_DEPTH {
                    return Err(malformed(part, "elements are nested too deeply"));
                }
                if stack.is_empty() && root.is_some() {
                    return Err(malformed(part, "more than one root element"));
                }
                stack.push(element_from(part, &e)?);
            }
            Event::Empty(e) => {
                let el = element_from(part, &e)?;
                attach(part, &mut stack, &mut root, el)?;
            }
            Event::End(_) => {
                let el = stack.pop().ok_or_else(|| malformed(part, "unbalanced end tag"))?;
                attach(part, &mut stack, &mut root, el)?;
            }
            Event::Text(t) => {
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(&t.xml10_content());
                }
            }
            Event::CData(c) => {
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(&c.xml10_content());
                }
            }
            Event::GeneralRef(r) => {
                if let Some(top) = stack.last_mut() {
                    push_ref(part, &r, &mut top.text)?;
                }
            }
            Event::DocType(_) => {
                return Err(Error::ForbiddenXml {
                    part: part.to_owned(),
                });
            }
            Event::Eof => break,
            Event::Decl(_) | Event::PI(_) | Event::Comment(_) => {}
        }
    }
    if !stack.is_empty() {
        return Err(malformed(part, "unclosed element"));
    }
    root.ok_or_else(|| malformed(part, "no root element"))
}

/// Rejects characters that XML 1.0 cannot carry or that would not survive a
/// round trip (control characters, including newlines).
pub(crate) fn check_value(field: &'static str, value: &str) -> Result<(), Error> {
    if value
        .chars()
        .any(|c| c.is_control() || c == '\u{fffe}' || c == '\u{ffff}')
    {
        return Err(Error::InvalidValue { field });
    }
    Ok(())
}

fn is_blank(text: &str) -> bool {
    text.bytes().all(|b| b.is_ascii_whitespace())
}

fn is_sx_metadata(part: &str, e: &BytesStart<'_>) -> Result<bool, Error> {
    if e.local_name().as_ref() != "metadata" {
        return Ok(false);
    }
    for attr in e.attributes() {
        let attr = attr.map_err(|err| xml_err(part, err))?;
        if attr.key.as_ref() == "name" {
            return Ok(attr.value.starts_with("sx:"));
        }
    }
    Ok(false)
}

fn root_with_sx_namespace(part: &str, e: &BytesStart<'_>) -> Result<BytesStart<'static>, Error> {
    if e.local_name().as_ref() != "model" {
        return Err(malformed(part, "root element is not model"));
    }
    // The `sx` prefix belongs to this format: a binding to any other
    // namespace (for example an earlier draft) is replaced.
    let mut start = BytesStart::new(e.name().as_ref().to_owned());
    let mut declared = false;
    for attr in e.attributes() {
        let attr = attr.map_err(|err| xml_err(part, err))?;
        if attr.key.as_ref() == "xmlns:sx" {
            start.push_attribute(("xmlns:sx", NAMESPACE));
            declared = true;
        } else {
            start.push_attribute(attr);
        }
    }
    if !declared {
        start.push_attribute(("xmlns:sx", NAMESPACE));
    }
    Ok(start)
}

fn write_entries<W: Write>(w: &mut Writer<W>, meta: &Sx3mfMetadata) -> Result<(), Error> {
    for (name, value) in meta.entries() {
        if let Some(value) = value {
            check_value("sx metadata", value)?;
            write!(
                w.get_mut(),
                "<metadata name=\"{name}\">{}</metadata>\n  ",
                escape(value)
            )?;
        }
    }
    Ok(())
}

/// See [`crate::write_metadata`].
pub(crate) fn rewrite_model(model_xml: &str, meta: &Sx3mfMetadata) -> Result<String, Error> {
    const PART: &str = "3D/3dmodel.model";
    for (_, value) in meta.entries() {
        if let Some(value) = value {
            check_value("sx metadata", value)?;
        }
    }
    let mut reader = Reader::from_str(model_xml);
    let mut writer = Writer::new(Vec::new());
    let mut depth = 0usize;
    let mut inserted = false;
    let mut pending: Option<Event<'static>> = None;

    macro_rules! flush {
        () => {
            if let Some(ev) = pending.take() {
                writer.write_event(ev)?;
            }
        };
    }

    loop {
        let ev = reader.read_event().map_err(|e| xml_err(PART, e))?;
        match ev {
            Event::DocType(_) => {
                return Err(Error::ForbiddenXml {
                    part: PART.to_owned(),
                });
            }
            Event::Eof => break,
            Event::Text(ref t) if depth == 1 && is_blank(t.as_ref()) => {
                flush!();
                pending = Some(ev.into_owned());
            }
            Event::Start(ref e) if depth == 0 => {
                writer.write_event(Event::Start(root_with_sx_namespace(PART, e)?))?;
                depth = 1;
            }
            Event::Empty(ref e) if depth == 0 => {
                // A self-closing root has no children: expand it.
                let start = root_with_sx_namespace(PART, e)?;
                let end = start.to_end().into_owned();
                writer.write_event(Event::Start(start))?;
                write!(writer.get_mut(), "\n  ")?;
                write_entries(&mut writer, meta)?;
                writer.write_event(Event::End(end))?;
                inserted = true;
            }
            Event::Start(ref e) | Event::Empty(ref e) if depth == 1 => {
                if is_sx_metadata(PART, e)? {
                    pending = None;
                    if matches!(ev, Event::Start(_)) {
                        reader.read_to_end(e.name()).map_err(|err| xml_err(PART, err))?;
                    }
                    continue;
                }
                flush!();
                if e.local_name().as_ref() != "metadata" && !inserted {
                    write_entries(&mut writer, meta)?;
                    inserted = true;
                }
                if matches!(ev, Event::Start(_)) {
                    depth += 1;
                }
                writer.write_event(ev)?;
            }
            Event::End(_) if depth == 1 => {
                flush!();
                if !inserted {
                    write_entries(&mut writer, meta)?;
                    inserted = true;
                }
                writer.write_event(ev)?;
                depth = 0;
            }
            Event::Start(_) => {
                flush!();
                depth += 1;
                writer.write_event(ev)?;
            }
            Event::End(_) => {
                flush!();
                depth = depth.saturating_sub(1);
                writer.write_event(ev)?;
            }
            _ => {
                flush!();
                writer.write_event(ev)?;
            }
        }
    }
    flush!();
    if !inserted {
        return Err(malformed(PART, "no model element"));
    }
    String::from_utf8(writer.into_inner()).map_err(|_| malformed(PART, "not valid UTF-8"))
}

/// The leading part of a model: whether it binds `sx`, its `sx:` entries and
/// the standard title, designer and application entries.
#[derive(Debug, Default)]
pub(crate) struct ModelHead {
    pub binds_sx: bool,
    pub any_sx_entry: bool,
    pub meta: Sx3mfMetadata,
    pub title: Option<String>,
    pub designer: Option<String>,
    pub application: Option<String>,
}

fn metadata_name(part: &str, e: &BytesStart<'_>) -> Result<Option<String>, Error> {
    for attr in e.attributes() {
        let attr = attr.map_err(|err| xml_err(part, err))?;
        if attr.key.as_ref() == "name" {
            let value = attr
                .normalized_value(XmlVersion::Implicit1_0)
                .map_err(|err| xml_err(part, err))?;
            return Ok(Some(value.into_owned()));
        }
    }
    Ok(None)
}

impl ModelHead {
    fn take(&mut self, name: Option<String>, text: String) {
        let Some(name) = name else { return };
        if text.is_empty() {
            return;
        }
        match name.as_str() {
            "Title" => self.title = Some(text),
            "Designer" => self.designer = Some(text),
            "Application" => self.application = Some(text),
            n if n.starts_with("sx:") => {
                self.any_sx_entry = true;
                self.meta.set(n, text);
            }
            _ => {}
        }
    }
}

/// Reads the model root and the `metadata` elements in front of the first
/// other child, then stops: resources and build are never read, so the model
/// can be any size. DOCTYPE and custom entities are refused.
pub(crate) fn read_model_head<R: BufRead>(part: &str, input: R) -> Result<ModelHead, Error> {
    let mut reader = Reader::from_reader(input);
    let mut buf = Vec::new();
    let mut head = ModelHead::default();
    let mut in_root = false;
    // Name and text of the metadata element being read.
    let mut current: Option<(Option<String>, String)> = None;
    loop {
        let ev = reader.read_event_into(&mut buf).map_err(|e| xml_err(part, e))?;
        match ev {
            Event::DocType(_) => {
                return Err(Error::ForbiddenXml {
                    part: part.to_owned(),
                });
            }
            Event::Start(ref e) | Event::Empty(ref e) if !in_root => {
                if e.local_name().as_ref() != "model" {
                    return Err(malformed(part, "root element is not model"));
                }
                for attr in e.attributes() {
                    let attr = attr.map_err(|err| xml_err(part, err))?;
                    if attr.key.as_ref() == "xmlns:sx" {
                        head.binds_sx = attr.value.as_ref() == NAMESPACE;
                    }
                }
                if matches!(ev, Event::Empty(_)) {
                    return Ok(head);
                }
                in_root = true;
            }
            Event::Start(ref e) if current.is_none() => {
                if e.local_name().as_ref() != "metadata" {
                    return Ok(head);
                }
                current = Some((metadata_name(part, e)?, String::new()));
            }
            Event::Empty(ref e) if current.is_none() => {
                if e.local_name().as_ref() != "metadata" {
                    return Ok(head);
                }
            }
            Event::Start(_) | Event::Empty(_) => {
                return Err(malformed(part, "metadata has child elements"));
            }
            Event::Text(t) => {
                if let Some((_, text)) = current.as_mut() {
                    text.push_str(&t.xml10_content());
                }
            }
            Event::CData(c) => {
                if let Some((_, text)) = current.as_mut() {
                    text.push_str(&c.xml10_content());
                }
            }
            Event::GeneralRef(r) => {
                if let Some((_, text)) = current.as_mut() {
                    push_ref(part, &r, text)?;
                }
            }
            Event::End(_) => match current.take() {
                Some((name, text)) => head.take(name, text),
                None => return Ok(head),
            },
            Event::Eof => {
                return Err(malformed(part, "the model ends inside its metadata"));
            }
            Event::Decl(_) | Event::PI(_) | Event::Comment(_) => {}
        }
        buf.clear();
    }
}
