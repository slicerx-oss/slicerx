// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! a ZIP reader for one small entry and a pull tokenizer for the XML of AMF
// offsets are checked against the buffer length before use
#![allow(clippy::indexing_slicing)]

use crate::error::{Error, Result};

const MAX_ENTRY: usize = 1 << 30;

fn u16_at(b: &[u8], at: usize) -> Option<usize> {
    b.get(at..at + 2)
        .map(|s| usize::from(u16::from_le_bytes([s[0], s[1]])))
}

fn u32_at(b: &[u8], at: usize) -> Option<usize> {
    b.get(at..at + 4)
        .and_then(|s| usize::try_from(u32::from_le_bytes([s[0], s[1], s[2], s[3]])).ok())
}

pub fn is_zip(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06")
}

pub fn read_entry(data: &[u8], suffix: &str) -> Result<Vec<u8>> {
    let bad = |why: &str| Error::mesh("amf", format!("zip: {why}"));
    let last = data.len().checked_sub(22).ok_or_else(|| bad("too short"))?;
    let eocd = (last.saturating_sub(65_535)..=last)
        .rev()
        .find(|&i| u32_at(data, i) == Some(0x0605_4b50))
        .ok_or_else(|| bad("no end record"))?;
    let count = u16_at(data, eocd + 10).ok_or_else(|| bad("truncated"))?;
    let mut at = u32_at(data, eocd + 16).ok_or_else(|| bad("truncated"))?;
    let want = suffix.to_ascii_lowercase();
    for _ in 0..count {
        if u32_at(data, at) != Some(0x0201_4b50) {
            return Err(bad("broken directory"));
        }
        let method = u16_at(data, at + 10).ok_or_else(|| bad("truncated"))?;
        let compressed = u32_at(data, at + 20).ok_or_else(|| bad("truncated"))?;
        let size = u32_at(data, at + 24).ok_or_else(|| bad("truncated"))?;
        let (n, m, k) = (
            u16_at(data, at + 28).ok_or_else(|| bad("truncated"))?,
            u16_at(data, at + 30).ok_or_else(|| bad("truncated"))?,
            u16_at(data, at + 32).ok_or_else(|| bad("truncated"))?,
        );
        let local = u32_at(data, at + 42).ok_or_else(|| bad("truncated"))?;
        let name = data.get(at + 46..at + 46 + n).ok_or_else(|| bad("truncated"))?;
        at += 46 + n + m + k;
        if !String::from_utf8_lossy(name)
            .to_ascii_lowercase()
            .ends_with(&want)
        {
            continue;
        }
        if u32_at(data, local) != Some(0x0403_4b50) {
            return Err(bad("broken entry header"));
        }
        let start = local
            + 30
            + u16_at(data, local + 26).ok_or_else(|| bad("truncated"))?
            + u16_at(data, local + 28).ok_or_else(|| bad("truncated"))?;
        let raw = data
            .get(start..start + compressed)
            .ok_or_else(|| bad("truncated entry"))?;
        if size > MAX_ENTRY {
            return Err(bad("entry too large"));
        }
        return match method {
            0 => Ok(raw.to_vec()),
            8 => miniz_oxide::inflate::decompress_to_vec_with_limit(raw, size.max(1))
                .map_err(|_| bad("bad deflate data")),
            _ => Err(bad("unsupported compression")),
        };
    }
    Err(bad(&format!("no entry ending in {suffix}")))
}

#[derive(Debug, PartialEq)]
pub enum Ev<'a> {
    Start {
        name: &'a str,
        attrs: &'a str,
        empty: bool,
    },
    End(&'a str),
    Text(&'a str),
}

pub fn attr<'a>(attrs: &'a str, key: &str) -> Option<&'a str> {
    let mut rest = attrs;
    while let Some(eq) = rest.find('=') {
        let name = rest[..eq].trim();
        let after = rest[eq + 1..].trim_start();
        let quote = after.chars().next().filter(|c| *c == '"' || *c == '\'')?;
        let body = &after[1..];
        let end = body.find(quote)?;
        if name == key {
            return Some(&body[..end]);
        }
        rest = &body[end + 1..];
    }
    None
}

pub fn events(xml: &str) -> impl Iterator<Item = Ev<'_>> {
    let mut pos = 0usize;
    std::iter::from_fn(move || {
        loop {
            let rest = xml.get(pos..)?;
            if rest.is_empty() {
                return None;
            }
            if let Some(lt) = rest.find('<') {
                if lt > 0 {
                    let text = rest[..lt].trim();
                    pos += lt;
                    if !text.is_empty() {
                        return Some(Ev::Text(text));
                    }
                    continue;
                }
            } else {
                pos = xml.len();
                let text = rest.trim();
                return (!text.is_empty()).then_some(Ev::Text(text));
            }
            if rest.starts_with("<!--") {
                pos += rest.find("-->").map_or(rest.len(), |e| e + 3);
                continue;
            }
            if let Some(body) = rest.strip_prefix("<![CDATA[") {
                let end = body.find("]]>").unwrap_or(body.len());
                pos += 9 + end + 3.min(body.len() - end);
                let text = body[..end].trim();
                if text.is_empty() {
                    continue;
                }
                return Some(Ev::Text(text));
            }
            let close = rest.find('>')?;
            let inner = &rest[1..close];
            pos += close + 1;
            if inner.starts_with('?') || inner.starts_with('!') {
                continue;
            }
            if let Some(name) = inner.strip_prefix('/') {
                return Some(Ev::End(name.trim()));
            }
            let (inner, empty) = inner.strip_suffix('/').map_or((inner, false), |i| (i, true));
            let name_end = inner.find(char::is_whitespace).unwrap_or(inner.len());
            return Some(Ev::Start {
                name: &inner[..name_end],
                attrs: &inner[name_end..],
                empty,
            });
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizer_reads_tags_attributes_and_text() {
        let xml = "<?xml version=\"1.0\"?><a unit='inch'><!-- c --><b id=\"2\" x=\"y\">7</b><c/></a>";
        let ev: Vec<_> = events(xml).collect();
        assert!(matches!(ev[0], Ev::Start { name: "a", .. }));
        if let Ev::Start { attrs, .. } = ev[0] {
            assert_eq!(attr(attrs, "unit"), Some("inch"));
        }
        if let Ev::Start { attrs, .. } = ev[1] {
            assert_eq!(attr(attrs, "x"), Some("y"));
            assert_eq!(attr(attrs, "id"), Some("2"));
            assert_eq!(attr(attrs, "nope"), None);
        }
        assert_eq!(ev[2], Ev::Text("7"));
        assert_eq!(ev[3], Ev::End("b"));
        assert!(matches!(
            ev[4],
            Ev::Start {
                name: "c",
                empty: true,
                ..
            }
        ));
    }

    #[test]
    fn zip_entries_stored_and_deflated() {
        let z = super::super::tests::zip(&[("a.txt", b"hello", false), ("dir/model.AMF", b"<amf/>", true)]);
        assert!(is_zip(&z));
        assert_eq!(read_entry(&z, ".amf").unwrap(), b"<amf/>");
        assert_eq!(read_entry(&z, "a.txt").unwrap(), b"hello");
        assert!(read_entry(&z, ".xyz").is_err());
        assert!(read_entry(b"PK\x03\x04junk", ".amf").is_err());
    }
}
