// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! a tag scanner for the xml in 3mf files: names, attributes, and the text before each tag

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Open,
    Close,
    /// `<a/>`, an open and a close in one
    Empty,
}

pub struct Tag<'a> {
    /// without a namespace prefix
    pub name: &'a str,
    pub attrs: &'a str,
    pub kind: Kind,
    /// the text between the previous tag and this one
    pub text: &'a str,
}

impl<'a> Tag<'a> {
    pub fn opens(&self) -> bool {
        self.kind != Kind::Close
    }

    pub fn closes(&self) -> bool {
        self.kind != Kind::Open
    }

    pub fn attr(&self, key: &str) -> Option<&'a str> {
        attrs(self.attrs).find(|(k, _)| *k == key).map(|(_, v)| v)
    }
}

/// `key="value"` pairs, quotes either way; a pair that does not parse ends the list
pub fn attrs(s: &str) -> impl Iterator<Item = (&str, &str)> {
    let mut rest = s;
    std::iter::from_fn(move || {
        let eq = rest.find('=')?;
        let key = rest.get(..eq)?.trim();
        let after = rest.get(eq + 1..)?.trim_start();
        let quote = after.chars().next().filter(|q| *q == '"' || *q == '\'')?;
        let body = after.get(1..)?;
        let end = body.find(quote)?;
        rest = body.get(end + 1..)?;
        Some((key, body.get(..end)?))
    })
}

/// calls `f` for every whole tag in `s`, and returns how much of `s` they cover; what is left starts mid tag
/// or is text after the last one. comments, declarations and processing instructions are skipped.
pub fn scan<E>(s: &str, mut f: impl FnMut(Tag<'_>) -> Result<(), E>) -> Result<usize, E> {
    let mut pos = 0;
    let mut text_from = 0;
    while let Some(lt) = s.get(pos..).and_then(|r| r.find('<')) {
        let start = pos + lt;
        let Some(gt) = s.get(start..).and_then(|r| r.find('>')) else {
            break;
        };
        let end = start + gt;
        let inner = s.get(start + 1..end).unwrap_or("");
        pos = end + 1;
        if inner.starts_with('?') || inner.starts_with('!') {
            // a comment can hold a '>': skip to its end
            if inner.starts_with("!--") && !inner.ends_with("--") {
                match s.get(start..).and_then(|r| r.find("-->")) {
                    Some(c) => pos = start + c + 3,
                    None => return Ok(start),
                }
            }
            continue;
        }
        let text = s.get(text_from..start).unwrap_or("");
        text_from = pos;
        let (kind, inner) = if let Some(r) = inner.strip_prefix('/') {
            (Kind::Close, r)
        } else if let Some(r) = inner.strip_suffix('/') {
            (Kind::Empty, r)
        } else {
            (Kind::Open, inner)
        };
        let name_end = inner
            .find(|c: char| c.is_ascii_whitespace())
            .unwrap_or(inner.len());
        let full = inner.get(..name_end).unwrap_or("");
        let name = full.rsplit(':').next().unwrap_or(full);
        f(Tag {
            name,
            attrs: inner.get(name_end..).unwrap_or(""),
            kind,
            text,
        })?;
    }
    Ok(text_from.min(s.len()))
}

/// the five named entities and numeric references
pub fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(rest.get(..i).unwrap_or(""));
        let tail = rest.get(i..).unwrap_or("");
        let Some(end) = tail.find(';') else {
            out.push_str(tail);
            return out;
        };
        let ent = tail.get(1..end).unwrap_or("");
        let ch = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => ent
                .strip_prefix("#x")
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| ent.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => out.push(c),
            None => out.push_str(tail.get(..=end).unwrap_or("")),
        }
        rest = tail.get(end + 1..).unwrap_or("");
    }
    out.push_str(rest);
    out
}
