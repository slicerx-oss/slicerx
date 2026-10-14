// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! prepares an inspectable stock replacement without changing a project.

use crate::script_review::{Identity, Review, ReviewInput, exact_fingerprint, review_known};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplacementInput {
    pub selected: Option<Identity>,
    #[serde(default)]
    pub declared: Vec<Identity>,
    pub key: String,
    pub original: String,
    pub replacement: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Replacement {
    pub schema_version: u32,
    pub decision: &'static str,
    pub reason: String,
    pub key: String,
    pub original: String,
    pub replacement: String,
    pub original_fingerprint: String,
    pub replacement_fingerprint: String,
    pub original_review: Review,
    pub stock_review: Review,
    pub diff: Vec<DiffLine>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub operation: &'static str,
    pub original_line: Option<usize>,
    pub replacement_line: Option<usize>,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Choice {
    pub key: String,
    pub slot: Option<usize>,
    pub original: String,
    pub replacement: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedReplacement {
    pub slot: Option<usize>,
    #[serde(flatten)]
    pub record: Replacement,
}

/// hosts supply the current explicit target and all current identity declarations.
/// verifies every choice before modifying any setting; records retain the originals.
pub fn apply_known(
    config: &mut serde_json::Map<String, serde_json::Value>,
    selected: Option<&Identity>,
    declared: &[Identity],
    choices: &[Choice],
) -> Result<Vec<AppliedReplacement>, String> {
    if choices.is_empty() || choices.len() > 64 {
        return Err("script replacement requires between 1 and 64 choices".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut records = Vec::with_capacity(choices.len());
    for choice in choices {
        if !seen.insert((&choice.key, choice.slot)) {
            return Err("duplicate script replacement choice".into());
        }
        let current = config.get(&choice.key).and_then(|value| match choice.slot {
            Some(slot) => value.as_array()?.get(slot)?.as_str(),
            None => value.as_str(),
        });
        if current != Some(choice.original.as_str()) {
            return Err("script replacement original no longer matches current text".into());
        }
        let mut record = prepare_known(&ReplacementInput {
            selected: selected.cloned(),
            declared: declared.to_vec(),
            key: choice.key.clone(),
            original: choice.original.clone(),
            replacement: choice.replacement.clone(),
        })?;
        if record.decision != "prepared" {
            return Err(record.reason);
        }
        record.decision = "applied";
        record.reason = "stock_replacement_applied".into();
        records.push(AppliedReplacement {
            slot: choice.slot,
            record,
        });
    }
    for choice in choices {
        let value = config
            .get_mut(&choice.key)
            .ok_or("script replacement key disappeared")?;
        let target = match choice.slot {
            Some(slot) => value
                .as_array_mut()
                .and_then(|items| items.get_mut(slot))
                .ok_or("script replacement slot disappeared")?,
            None => value,
        };
        *target = serde_json::Value::String(choice.replacement.clone());
    }
    Ok(records)
}

/// keeps exact line endings and a linear-size diff, not a minimal edit script.
fn diff(original: &str, replacement: &str) -> Vec<DiffLine> {
    let before: Vec<_> = original.split_inclusive('\n').collect();
    let after: Vec<_> = replacement.split_inclusive('\n').collect();
    let prefix = before.iter().zip(&after).take_while(|(a, b)| a == b).count();
    let suffix = before
        .iter()
        .skip(prefix)
        .rev()
        .zip(after.iter().skip(prefix).rev())
        .take_while(|(a, b)| a == b)
        .count();
    let line = |operation, old, new, text: &str| DiffLine {
        operation,
        original_line: old,
        replacement_line: new,
        text: text.into(),
    };
    before
        .iter()
        .take(prefix)
        .enumerate()
        .map(|(i, text)| line("equal", Some(i + 1), Some(i + 1), text))
        .chain(
            before
                .iter()
                .skip(prefix)
                .take(before.len() - suffix - prefix)
                .enumerate()
                .map(|(i, text)| line("remove", Some(prefix + i + 1), None, text)),
        )
        .chain(
            after
                .iter()
                .skip(prefix)
                .take(after.len() - suffix - prefix)
                .enumerate()
                .map(|(i, text)| line("add", None, Some(prefix + i + 1), text)),
        )
        .chain(
            before
                .iter()
                .skip(before.len() - suffix)
                .enumerate()
                .map(|(i, text)| {
                    line(
                        "equal",
                        Some(before.len() - suffix + i + 1),
                        Some(after.len() - suffix + i + 1),
                        text,
                    )
                }),
        )
        .collect()
}

/// preparation is a read-back, not a reusable trust grant or permission to print.
pub fn prepare_known(input: &ReplacementInput) -> Result<Replacement, String> {
    if input.original.len() > 1_048_576 || input.replacement.len() > 1_048_576 {
        return Err("script replacement text exceeds 1 MiB".into());
    }
    let review = |text: &str| {
        review_known(&ReviewInput {
            selected: input.selected.clone(),
            declared: input.declared.clone(),
            key: input.key.clone(),
            text: text.into(),
        })
    };
    let original_review = review(&input.original)?;
    let stock_review = review(&input.replacement)?;
    let accepted = matches!(stock_review.decision, "exact" | "cosmetic");
    Ok(Replacement {
        schema_version: 1,
        decision: if accepted { "prepared" } else { "review" },
        reason: if accepted {
            "stock_replacement_prepared".into()
        } else {
            stock_review.reason.clone()
        },
        key: input.key.clone(),
        original: input.original.clone(),
        replacement: input.replacement.clone(),
        original_fingerprint: exact_fingerprint(&input.original),
        replacement_fingerprint: exact_fingerprint(&input.replacement),
        original_review,
        stock_review,
        diff: diff(&input.original, &input.replacement),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> ReplacementInput {
        ReplacementInput {
            selected: Some(Identity {
                model: "bambu-p1s".into(),
                firmware: "marlin".into(),
            }),
            declared: Vec::new(),
            key: "machine_pause_gcode".into(),
            original: "M400 U1\r\n\r\nM500".into(),
            replacement: "M400 U1".into(),
        }
    }

    #[test]
    fn application_is_atomic_and_preserves_other_settings() {
        let request = input();
        let mut config = serde_json::json!({
            "machine_pause_gcode": [request.original, "second slot"],
            "layer_height": 0.2,
            "ordinary_setting": {"keep": [1, 2, 3]}
        })
        .as_object()
        .unwrap()
        .clone();
        let before = config.clone();
        let mut choices = vec![
            Choice {
                key: request.key.clone(),
                slot: Some(0),
                original: request.original.clone(),
                replacement: request.replacement.clone(),
            },
            Choice {
                key: request.key.clone(),
                slot: Some(1),
                original: "stale".into(),
                replacement: request.replacement.clone(),
            },
        ];
        assert!(apply_known(&mut config, request.selected.as_ref(), &[], &choices).is_err());
        assert_eq!(config, before);
        choices.pop();
        let records = apply_known(&mut config, request.selected.as_ref(), &[], &choices).unwrap();
        assert_eq!(records.first().unwrap().record.original, request.original);
        assert_eq!(records.first().unwrap().record.decision, "applied");
        let mut expected = before;
        expected.insert(
            request.key,
            serde_json::json!([request.replacement, "second slot"]),
        );
        assert_eq!(config, expected);
        assert!(apply_known(&mut config, request.selected.as_ref(), &[], &choices).is_err());
        assert_eq!(config, expected);
    }

    #[test]
    fn application_rechecks_stock_and_current_target() {
        let request = input();
        let config = serde_json::json!({request.key.clone(): request.original})
            .as_object()
            .unwrap()
            .clone();
        let mut choices = vec![Choice {
            key: request.key,
            slot: None,
            original: request.original,
            replacement: request.replacement,
        }];
        let mut actual = config.clone();
        let conflicting = Identity {
            model: "bambu-a1".into(),
            firmware: "marlin".into(),
        };
        assert_eq!(
            apply_known(&mut actual, request.selected.as_ref(), &[conflicting], &choices).unwrap_err(),
            "printer_identity_conflict"
        );
        assert_eq!(actual, config);
        choices.first_mut().unwrap().replacement.push_str("\nM500");
        assert_eq!(
            apply_known(&mut actual, request.selected.as_ref(), &[], &choices).unwrap_err(),
            "script_changed"
        );
        assert_eq!(actual, config);
    }

    #[test]
    fn retains_the_original_and_reconstructs_both_texts_from_the_diff() {
        let request = input();
        let record = prepare_known(&request).unwrap();
        assert_eq!(record.decision, "prepared");
        assert_eq!(record.original, request.original);
        assert_eq!(record.original_review.reason, "script_changed");
        assert_eq!(record.stock_review.reason, "stock_equivalent");
        for (excluded, expected) in [("add", &request.original), ("remove", &request.replacement)] {
            let restored: String = record
                .diff
                .iter()
                .filter(|line| line.operation != excluded)
                .map(|line| line.text.as_str())
                .collect();
            assert_eq!(&restored, expected);
        }
    }

    #[test]
    fn refuses_changed_stock_or_conflicting_targets() {
        let mut request = input();
        request.replacement.push_str("\nM500");
        assert_eq!(prepare_known(&request).unwrap().reason, "script_changed");
        request.replacement = "M400 U1".into();
        request.declared.push(Identity {
            model: "bambu-a1".into(),
            firmware: "marlin".into(),
        });
        assert_eq!(
            prepare_known(&request).unwrap().reason,
            "printer_identity_conflict"
        );
        request.selected = None;
        assert_eq!(
            prepare_known(&request).unwrap().reason,
            "printer_identity_required"
        );
    }

    #[test]
    fn diff_preserves_empty_and_repeated_lines() {
        for (before, after) in [
            ("", "M400 U1\n"),
            ("a\n", ""),
            ("a\na\n", "a\na\n"),
            ("a\nx\na\n", "a\ny\na\n"),
        ] {
            let lines = diff(before, after);
            assert_eq!(
                lines
                    .iter()
                    .filter(|l| l.operation != "add")
                    .map(|l| l.text.as_str())
                    .collect::<String>(),
                before
            );
            assert_eq!(
                lines
                    .iter()
                    .filter(|l| l.operation != "remove")
                    .map(|l| l.text.as_str())
                    .collect::<String>(),
                after
            );
        }
    }
}
