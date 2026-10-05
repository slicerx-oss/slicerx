// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Canonical JSON and parameter hashing, byte for byte the same as `canonicalJson` and
//! `hashParams` in `packages/contracts/src/pilot.ts`. Pilot hashes parameters in TypeScript
//! and the host hashes them again in Rust, so any difference here fails every approval.
use std::fmt::Write as _;

use serde_json::Value;
use sha2::{Digest, Sha256};

/// Serializes `value` the way the TypeScript `canonicalJson` does: object keys sorted at
/// every level (by UTF-16 code units, as JavaScript compares strings), no whitespace,
/// strings escaped as `JSON.stringify` escapes them, and numbers written as JavaScript
/// writes a double (`1` for `1.0`, `1e+21`, `1e-7`, integers past 2^53 rounded).
///
/// ```
/// let v = serde_json::json!({"b": [1.0, "x"], "a": null});
/// assert_eq!(sx_permit::canonical_json(&v), r#"{"a":null,"b":[1,"x"]}"#);
/// ```
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

/// Lowercase hex SHA-256 of [`canonical_json`]. Pass `Value::Null` for missing parameters.
///
/// ```
/// let h = sx_permit::hash_params(&serde_json::json!({"printerId": "bay-1"}));
/// assert_eq!(h.len(), 64);
/// ```
pub fn hash_params(params: &Value) -> String {
    hex(&Sha256::digest(canonical_json(params).as_bytes()))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        // Writing to a String cannot fail.
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        // `as_f64` is always `Some` without serde_json's arbitrary_precision feature. JSON
        // has no NaN or Infinity, and JSON.stringify writes those as null anyway.
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.is_finite() => write_js_number(out, f),
            _ => out.push_str("null"),
        },
        Value::String(s) => write_js_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, (k, v)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_js_string(out, k);
                out.push(':');
                write_value(out, v);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify` of a string. Rust strings are valid UTF-8, so the lone surrogate case
/// of the JavaScript algorithm cannot occur.
fn write_js_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{09}' => out.push_str("\\t"),
            '\u{0a}' => out.push_str("\\n"),
            '\u{0c}' => out.push_str("\\f"),
            '\u{0d}' => out.push_str("\\r"),
            c if u32::from(c) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// ECMAScript `Number::toString` for a finite double. Rust's `{:e}` gives the shortest
/// digit string that round-trips, which is the digit string the spec asks for; this
/// function only places the decimal point and the exponent the way JavaScript does.
fn write_js_number(out: &mut String, f: f64) {
    if f == 0.0 {
        // Covers -0, which JavaScript writes as "0".
        out.push('0');
        return;
    }
    if f < 0.0 {
        out.push('-');
    }
    let (digits, exp) = sci_digits(&format!("{:e}", f.abs()));
    let digits = even_on_tie(f.abs(), digits, exp);
    let k = i64::try_from(digits.len()).unwrap_or(i64::MAX);
    // Position of the decimal point relative to the start of the digits.
    let n = exp + 1;
    if k <= n && n <= 21 {
        out.push_str(&digits);
        push_zeros(out, n - k);
    } else if 0 < n && n <= 21 {
        let (int, frac) = split_digits(&digits, n);
        out.push_str(int);
        out.push('.');
        out.push_str(frac);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        push_zeros(out, -n);
        out.push_str(&digits);
    } else {
        let (first, rest) = split_digits(&digits, 1);
        out.push_str(first);
        if !rest.is_empty() {
            out.push('.');
            out.push_str(rest);
        }
        let e = n - 1;
        out.push('e');
        out.push(if e < 0 { '-' } else { '+' });
        let _ = write!(out, "{}", e.unsigned_abs());
    }
}

/// Splits Rust scientific notation (`1.2345e-7`) into its digit string and exponent.
fn sci_digits(sci: &str) -> (String, i64) {
    let (mantissa, exp) = sci.split_once('e').unwrap_or((sci, "0"));
    let digits = mantissa.chars().filter(char::is_ascii_digit).collect();
    (digits, exp.parse().unwrap_or(0))
}

/// When two shortest digit strings are equally close to `x`, ECMAScript picks the even one
/// and Rust rounds half up (`1242781858855889.25` is `...889.2` in JavaScript, `...889.3`
/// in Rust). This finds that tie from the exact decimal expansion of `x` and swaps in the
/// even candidate when it still round-trips.
fn even_on_tie(x: f64, digits: String, exp: i64) -> String {
    if digits.bytes().last().is_none_or(|d| (d - b'0').is_multiple_of(2)) {
        return digits;
    }
    // Every double has an exact decimal expansion of at most 767 significant digits.
    let (exact, exact_exp) = sci_digits(&format!("{x:.1100e}"));
    let k = digits.len();
    let (Some(prefix), Some(rest)) = (exact.get(..k), exact.get(k..)) else {
        return digits;
    };
    let tie = exact_exp == exp && rest.starts_with('5') && rest.bytes().skip(1).all(|d| d == b'0');
    if !tie {
        return digits;
    }
    let even = if prefix
        .bytes()
        .last()
        .is_some_and(|d| (d - b'0').is_multiple_of(2))
    {
        prefix.to_owned()
    } else {
        match increment(prefix) {
            Some(next) => next,
            None => return digits,
        }
    };
    let exp_of_last = exp - i64::try_from(k).unwrap_or(0) + 1;
    match format!("{even}e{exp_of_last}").parse::<f64>() {
        Ok(back) if back.to_bits() == x.to_bits() => even,
        _ => digits,
    }
}

/// Adds one in the last place of an ASCII digit string, or `None` when that would add a
/// digit.
fn increment(digits: &str) -> Option<String> {
    let mut bytes = digits.as_bytes().to_vec();
    for d in bytes.iter_mut().rev() {
        if *d == b'9' {
            *d = b'0';
        } else {
            *d += 1;
            return String::from_utf8(bytes).ok();
        }
    }
    None
}

fn split_digits(digits: &str, at: i64) -> (&str, &str) {
    let at = usize::try_from(at).unwrap_or(0).min(digits.len());
    // `digits` is ASCII, so every index is a char boundary.
    digits.split_at_checked(at).unwrap_or((digits, ""))
}

fn push_zeros(out: &mut String, count: i64) {
    for _ in 0..count {
        out.push('0');
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn num(f: f64) -> String {
        let mut s = String::new();
        write_js_number(&mut s, f);
        s
    }

    #[test]
    fn numbers_match_javascript() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.1, "0.1"),
            (0.1 + 0.2, "0.30000000000000004"),
            (123_456_789.0, "123456789"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (0.000_001, "0.000001"),
            (1e-7, "1e-7"),
            (1.25e-7, "1.25e-7"),
            (250.4, "250.4"),
            (f64::MAX, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
            (9_007_199_254_740_993.0, "9007199254740992"),
        ];
        for (f, want) in cases {
            assert_eq!(num(*f), *want, "for {f:?}");
        }
        // Exact doubles halfway between two shortest candidates: JavaScript takes the even
        // digit. Written as strings because the literals would round the same way.
        let ties = [
            ("1242781858855889.25", "1242781858855889.2"),
            ("233255755685135.125", "233255755685135.12"),
            ("1303311826788.40625", "1303311826788.4062"),
            ("-26241251243453.0625", "-26241251243453.062"),
        ];
        for (exact, want) in ties {
            assert_eq!(num(exact.parse().unwrap()), want, "for {exact}");
        }
    }

    #[test]
    fn parsed_floats_round_correctly() {
        // Needs serde_json's float_roundtrip feature: the default parser is off by one ulp
        // here, and JavaScript's JSON.parse is exact.
        let v: Value = serde_json::from_str("[3.323909557327667e-194, 2.1400917060418742e+79]").unwrap();
        assert_eq!(
            canonical_json(&v),
            "[3.323909557327667e-194,2.1400917060418742e+79]"
        );
    }

    #[test]
    fn integers_past_two_to_the_53_round_like_javascript() {
        let v: Value = serde_json::from_str("[12345678901234567890, -9007199254740993]").unwrap();
        assert_eq!(canonical_json(&v), "[12345678901234567000,-9007199254740992]");
    }

    #[test]
    fn strings_escape_like_json_stringify() {
        let v = json!("a\"b\\c\n\t\r\u{08}\u{0c}\u{01}\u{1f}\u{7f}\u{2028}é");
        assert_eq!(
            canonical_json(&v),
            "\"a\\\"b\\\\c\\n\\t\\r\\b\\f\\u0001\\u001f\u{7f}\u{2028}é\""
        );
    }

    #[test]
    fn keys_sort_by_utf16_code_units() {
        // U+1D11E is a surrogate pair (D834 DD1E) and sorts before U+FF5E in JavaScript,
        // although its UTF-8 bytes sort after.
        let v = json!({"\u{ff5e}": 1, "\u{1d11e}": 2, "b": {"z": 1, "a": [true, null]}, "a": 0});
        assert_eq!(
            canonical_json(&v),
            "{\"a\":0,\"b\":{\"a\":[true,null],\"z\":1},\"\u{1d11e}\":2,\"\u{ff5e}\":1}"
        );
    }

    #[test]
    fn hash_is_lowercase_hex_sha256() {
        // sha256("null")
        assert_eq!(
            hash_params(&Value::Null),
            "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
        );
    }
}
