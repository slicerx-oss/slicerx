// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! conservative cosmetic normalization; matching a trusted identity is a separate step.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalScript {
    pub version: u32,
    pub text: String,
    pub fingerprint: String,
    pub ignored: Vec<&'static str>,
}

/// preserves executable text, template expressions and quoted strings verbatim.
pub fn canonicalize(input: &str) -> Result<CanonicalScript, String> {
    if input.contains('\0') {
        return Err("nul byte in script".into());
    }
    crate::template::validate(input)?;
    // a carriage return inside a literal is data, not a cosmetic line ending.
    let mut literal = None;
    let mut escape = false;
    let mut comment_line = false;
    let mut expression_depth = 0_u32;
    for c in input.chars() {
        if c == '\r' && (literal.is_some() || expression_depth > 0) {
            return Err("carriage return in a quoted literal requires exact script review".into());
        }
        if escape {
            escape = false;
        } else if let Some(q) = literal {
            if c == '\\' {
                escape = true;
            } else if c == q {
                literal = None;
            }
        } else if matches!(c, '"' | '\'') && (!comment_line || expression_depth > 0) {
            literal = Some(c);
        } else if matches!(c, '{' | '[') {
            expression_depth += 1;
        } else if matches!(c, '}' | ']') {
            expression_depth = expression_depth.saturating_sub(1);
        } else if c == ';' && expression_depth == 0 {
            comment_line = true;
        } else if matches!(c, '\r' | '\n') {
            comment_line = false;
        }
    }
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let mut ignored = Vec::new();
    if normalized != input {
        ignored.push("lineEndings");
    }
    let mut braces = 0_u32;
    let mut brackets = 0_u32;
    let mut quote = None;
    let mut escaped = false;
    let mut conditional = false;
    let mut lines = Vec::new();
    for raw in normalized.split('\n') {
        let command = raw
            .trim_start()
            .split_ascii_whitespace()
            .next()
            .unwrap_or_default();
        match command.to_ascii_uppercase().as_str() {
            "M622" if conditional => return Err("nested firmware condition requires review".into()),
            "M622" => conditional = true,
            "M623" if !conditional => return Err("unmatched firmware condition end".into()),
            "M623" => conditional = false,
            _ => {}
        }
        if matches!(
            command.to_ascii_uppercase().as_str(),
            "M0" | "M1" | "M117" | "M118"
        ) {
            return Err("free-text command requires exact script review".into());
        }
        let protected_start = braces > 0 || brackets > 0 || quote.is_some();
        let mut comment = None;
        let mut template_comment = false;
        for (at, c) in raw.char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            if let Some(q) = quote {
                if c == '\\' {
                    escaped = true;
                } else if c == q {
                    quote = None;
                }
                continue;
            }
            match c {
                '"' | '\'' if comment.is_none() || braces > 0 || brackets > 0 => quote = Some(c),
                '{' => braces += 1,
                '}' if braces > 0 => braces -= 1,
                '[' => brackets += 1,
                ']' if brackets > 0 => brackets -= 1,
                ';' if braces == 0 && brackets == 0 && comment.is_none() => {
                    comment = Some(at);
                    template_comment = raw[at + 1..].contains(['{', '}', '[', ']']);
                    if !template_comment {
                        break;
                    }
                }
                _ => {}
            }
        }
        if template_comment && (braces > 0 || brackets > 0 || quote.is_some()) {
            return Err("multiline template in a comment requires exact script review".into());
        }
        // templates in comments still execute, and host directives are not ordinary comments.
        let inert = comment.filter(|&at| {
            let tail = raw.get(at + 1..).unwrap_or_default();
            let directive = tail.trim_start();
            !tail.contains(['{', '}', '[', ']'])
                && !directive.starts_with(['@', '_'])
                && ![
                    "TYPE:",
                    "FEATURE:",
                    "LAYER:",
                    "LAYER_CHANGE",
                    "WIPE_START",
                    "WIPE_END",
                ]
                .iter()
                .any(|tag| directive.starts_with(tag))
        });
        let mut line = inert.map_or(raw, |at| raw.get(..at).unwrap_or_default());
        if inert.is_some() && !ignored.contains(&"comments") {
            ignored.push("comments");
        }
        if !protected_start && !template_comment {
            let trimmed = line.trim_start_matches([' ', '\t']);
            if trimmed != line && !ignored.contains(&"indentation") {
                ignored.push("indentation");
            }
            line = trimmed;
        }
        if braces == 0 && brackets == 0 && quote.is_none() && !template_comment {
            let trimmed = line.trim_end_matches([' ', '\t']);
            if trimmed != line && !ignored.contains(&"trailingWhitespace") {
                ignored.push("trailingWhitespace");
            }
            line = trimmed;
        }
        if !line.is_empty() || protected_start || braces > 0 || brackets > 0 || quote.is_some() {
            lines.push(line);
        } else if !ignored.contains(&"blankLines") {
            ignored.push("blankLines");
        }
    }
    if braces != 0 || brackets != 0 || quote.is_some() || escaped || conditional {
        return Err("unclosed expression or quoted string in script".into());
    }
    let text = lines.join("\n");
    let mut fingerprint = String::with_capacity(64);
    for byte in Sha256::digest(text.as_bytes()) {
        let _ = write!(fingerprint, "{byte:02x}");
    }
    Ok(CanonicalScript {
        version: 1,
        text,
        fingerprint,
        ignored,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(src: &str) -> String {
        canonicalize(src).unwrap().text
    }

    #[test]
    fn ordinary_comments_and_indentation_do_not_change_commands() {
        assert_eq!(text("\r\n  G28 ; home\r\n\tM500\t; save\r\n"), text("G28\nM500"));
        assert_eq!(
            canonicalize("M500 ; save").unwrap().fingerprint,
            canonicalize("M500").unwrap().fingerprint
        );
    }

    #[test]
    fn executable_changes_remain_distinct() {
        assert_ne!(text("G1 F{60 / 2.4053}"), text("G1 F{60 / 2.405}"));
        let stock = text("G28\nM500\nG1 X1");
        for changed in [
            "M500\nG28\nG1 X1",
            "G28\nM500\nM500\nG1 X1",
            "G28\nM500\nG1 X2",
            "G28\nM500\nG1 X1.0",
        ] {
            assert_ne!(stock, text(changed));
        }
        assert_ne!(text("M622 J1\nM500\nM623"), text("M622 J2\nM500\nM623"));
        assert_ne!(
            text("{if enabled}\nM500\n{endif}"),
            text("{if other}\nM500\n{endif}")
        );
    }

    #[test]
    fn quoted_comments_and_template_side_effects_are_preserved() {
        assert_ne!(text("G1 X{\"a; b\"}"), text("G1 X{\"a; c\"}"));
        for src in ["M118 \"a; b\" ; note", "; {\"a\r\nb\"}"] {
            assert!(canonicalize(src).is_err());
        }
        assert_eq!(text(";@L 1"), ";@L 1");
        assert_ne!(text(";TYPE:Outer wall"), text(";TYPE:Inner wall"));
        assert_eq!(
            text("; printer's {local n = 1}\n  G1 X{n} ; note"),
            "; printer's {local n = 1}\nG1 X{n}"
        );
        assert_ne!(text("; {local n = 1}\nG1 X{n}"), text("; {local n = 2}\nG1 X{n}"));
        assert_ne!(text("; {\"\\nM500\"}"), text("; ordinary"));
    }

    #[test]
    fn canonical_form_keeps_rendered_comment_side_effects() {
        let context = crate::template::Context::default();
        let source = "; printer's {local n = 2}\n  G1 X{n} ; move";
        let rendered = crate::template::render(&text(source), &context).unwrap();
        assert_eq!(rendered, "; printer's \nG1 X2");
        let injected = "; {\"\\nM500\"}";
        assert_eq!(
            crate::template::render(&text(injected), &context).unwrap(),
            "; \nM500"
        );
        assert_ne!(text(injected), text("; safe note"));
    }

    #[test]
    fn malformed_scripts_require_review() {
        for src in [
            "{if x}\nM500",
            "{endif}",
            "{broken",
            "M118 \"broken",
            "G1 X[name",
            "M500\0",
            "G1 X{\"a\r\nb\"}",
            "M622 J1\nM500",
            "M623",
            "M622 J1\nM622 J0\nM500\nM623\nM623",
        ] {
            assert!(canonicalize(src).is_err(), "{src:?}");
        }
    }

    #[test]
    fn decimal_commands_and_multiline_literals_remain_distinct() {
        assert_eq!(
            text("M622.1 S0\nM622 J1\nM500\nM623"),
            "M622.1 S0\nM622 J1\nM500\nM623"
        );
        assert_ne!(text("G1 X{\"a\n  b\"}"), text("G1 X{\"a\nb\"}"));
        assert_eq!(
            text("{if enabled}\n  M500 ; save\n{endif}"),
            text("{if enabled}\nM500\n{endif}")
        );
    }
}
