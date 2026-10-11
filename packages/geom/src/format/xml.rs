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
    // a byte loop: the values are short, and a search per quote costs more than walking them
    let b = s.as_bytes();
    let mut at = 0;
    std::iter::from_fn(move || {
        while b.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
        }
        let key_from = at;
        while b.get(at).is_some_and(|&c| c != b'=') {
            at += 1;
        }
        let key = s.get(key_from..at)?.trim_ascii();
        at += 1;
        while b.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
        }
        let quote = *b.get(at).filter(|&&q| q == b'"' || q == b'\'')?;
        at += 1;
        let from = at;
        while b.get(at).is_some_and(|&c| c != quote) {
            at += 1;
        }
        let value = s.get(from..at)?;
        b.get(at)?;
        at += 1;
        Some((key, value))
    })
}

/// `v.trim().parse::<f32>()`, the same bits: a plain decimal of up to seven digits is one exact division
pub fn f32_of(v: &str) -> Option<f32> {
    let t = v.trim_ascii();
    let b = t.as_bytes();
    let (neg, digits) = match b.first() {
        Some(b'-') => (true, b.get(1..).unwrap_or_default()),
        Some(b'+') => (false, b.get(1..).unwrap_or_default()),
        _ => (false, b),
    };
    let mut m: u32 = 0;
    let mut frac: Option<u32> = None;
    let mut seen = false;
    for &c in digits {
        match c {
            b'0'..=b'9' => {
                seen = true;
                m = match m.checked_mul(10).and_then(|x| x.checked_add(u32::from(c - b'0'))) {
                    Some(x) if x <= 1 << 24 => x,
                    _ => return v.trim().parse().ok(),
                };
                if let Some(k) = frac.as_mut() {
                    *k += 1;
                }
            }
            b'.' if frac.is_none() => frac = Some(0),
            _ => return v.trim().parse().ok(),
        }
    }
    let k = frac.unwrap_or(0);
    if !seen || k > 10 {
        return v.trim().parse().ok();
    }
    // both exact in f32, so the one rounding is the division's: the correctly rounded value
    #[allow(clippy::cast_precision_loss, reason = "at most 2^24")]
    let x = m as f32
        / [1e0f32, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10]
            .get(k as usize)
            .copied()?;
    Some(if neg { -x } else { x })
}

/// `v.trim().parse::<u32>()`
pub fn u32_of(v: &str) -> Option<u32> {
    let t = v.trim_ascii();
    let mut n: u32 = 0;
    if t.is_empty() || !t.bytes().all(|c| c.is_ascii_digit()) {
        return v.trim().parse().ok();
    }
    for c in t.bytes() {
        n = n.checked_mul(10)?.checked_add(u32::from(c - b'0'))?;
    }
    Some(n)
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
        let b = inner.as_bytes();
        let name_end = b.iter().position(u8::is_ascii_whitespace).unwrap_or(b.len());
        let name_from = b
            .get(..name_end)
            .and_then(|n| n.iter().rposition(|&c| c == b':'))
            .map_or(0, |c| c + 1);
        let name = inner.get(name_from..name_end).unwrap_or("");
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

#[cfg(test)]
mod tests {
    use super::{f32_of, u32_of};

    #[test]
    fn numbers_read_as_std_reads_them() {
        let mut texts: Vec<String> = [
            "0",
            "-0",
            "+1",
            "1.",
            ".5",
            "-.25",
            " 3.25 ",
            "16777216",
            "16777217",
            "0.1",
            "1e3",
            "inf",
            "nan",
            "",
            "-",
            "1.2.3",
            "12345678.9",
            "0.00000000001",
            "99999.99",
            "-128.0049",
            "abc",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        // a sweep of decimals with up to seven digits and three to five places, as slicers write them
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        for _ in 0..200_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let digits = x % 10_000_000;
            let places = 1 + (x >> 40) % 6;
            let s = format!("{digits}");
            let p = usize::try_from(places).unwrap_or(1).min(s.len());
            let (a, b) = s.split_at(s.len() - p);
            texts.push(format!(
                "{}{}.{b}",
                if x & 1 == 1 { "-" } else { "" },
                if a.is_empty() { "0" } else { a }
            ));
        }
        for t in &texts {
            let want = t.trim().parse::<f32>().ok();
            let got = f32_of(t);
            assert_eq!(got.map(f32::to_bits), want.map(f32::to_bits), "{t}");
            assert_eq!(u32_of(t), t.trim().parse::<u32>().ok(), "{t}");
        }
    }
}
