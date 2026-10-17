// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! matches scripts against a caller's trusted, versioned stock catalog.

use crate::par::Init;
use crate::script_canonical::canonicalize;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Identity {
    pub model: String,
    pub firmware: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewInput {
    pub selected: Option<Identity>,
    #[serde(default)]
    pub declared: Vec<Identity>,
    pub key: String,
    pub text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    schema_version: u32,
    scripts: Vec<StockScript>,
}

/// the catalog is compiled in; a project cannot supply trusted fingerprints.
pub fn review_known(input: &ReviewInput) -> Result<Review, String> {
    static CATALOG: OnceLock<Result<Catalog, String>> = OnceLock::new();
    let catalog = CATALOG
        .once(|| {
            serde_json::from_str(include_str!("../data/canonical-stock.json")).map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)?;
    if catalog.schema_version != 1 {
        return Err("unsupported stock catalog version".into());
    }
    Ok(review(
        input.selected.as_ref(),
        &input.declared,
        &input.key,
        &input.text,
        &catalog.scripts,
    ))
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockScript {
    pub identity: Identity,
    pub key: String,
    pub source: String,
    pub version: String,
    pub exact_fingerprint: String,
    pub canonical_version: u32,
    pub canonical_fingerprint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub schema_version: u32,
    pub decision: &'static str,
    pub reason: String,
    pub identity: Option<Identity>,
    pub source: Option<String>,
    pub stock_version: Option<String>,
    pub fingerprint: Option<String>,
    pub ignored: Vec<&'static str>,
}

pub fn exact_fingerprint(text: &str) -> String {
    use std::fmt::Write as _;
    let mut hash = String::with_capacity(64);
    for byte in Sha256::digest(text.as_bytes()) {
        let _ = write!(hash, "{byte:02x}");
    }
    hash
}

/// `catalog` must come from shipped stock data, never from an imported project.
pub fn review(
    selected: Option<&Identity>,
    declared: &[Identity],
    key: &str,
    text: &str,
    catalog: &[StockScript],
) -> Review {
    let mut result = Review {
        schema_version: 1,
        decision: "review",
        reason: "printer_identity_required".into(),
        identity: selected.cloned(),
        source: None,
        stock_version: None,
        fingerprint: None,
        ignored: Vec::new(),
    };
    let Some(identity) = selected.filter(|i| !i.model.trim().is_empty() && !i.firmware.trim().is_empty())
    else {
        return result;
    };
    if declared.iter().any(|i| i != identity) {
        result.reason = "printer_identity_conflict".into();
        return result;
    }
    let candidates: Vec<&StockScript> = catalog
        .iter()
        .filter(|s| s.identity == *identity && s.key == key && !s.source.is_empty() && !s.version.is_empty())
        .collect();
    if candidates.is_empty() {
        result.reason = "stock_version_unknown".into();
        return result;
    }
    let exact = exact_fingerprint(text);
    let mut matched = candidates.iter().copied().find(|s| s.exact_fingerprint == exact);
    if matched.is_some() {
        result.decision = "exact";
        result.fingerprint = Some(exact);
    } else {
        let canonical = match canonicalize(text) {
            Ok(canonical) => canonical,
            Err(reason) => {
                result.reason = format!("script_parse_required: {reason}");
                return result;
            }
        };
        matched = candidates.iter().copied().find(|s| {
            s.canonical_version == canonical.version
                && s.canonical_fingerprint.as_deref() == Some(canonical.fingerprint.as_str())
        });
        if matched.is_some() {
            result.decision = "cosmetic";
            result.fingerprint = Some(canonical.fingerprint);
            result.ignored = canonical.ignored;
        }
    }
    if let Some(stock) = matched {
        result.reason = "stock_equivalent".into();
        result.source = Some(stock.source.clone());
        result.stock_version = Some(stock.version.clone());
    } else {
        result.reason = "script_changed".into();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> Identity {
        Identity {
            model: "test-printer".into(),
            firmware: "marlin".into(),
        }
    }

    fn catalog(text: &str) -> Vec<StockScript> {
        vec![StockScript {
            identity: identity(),
            key: "machine_start_gcode".into(),
            source: "test-stock".into(),
            version: "1.0".into(),
            exact_fingerprint: exact_fingerprint(text),
            canonical_version: 1,
            canonical_fingerprint: canonicalize(text).ok().map(|c| c.fingerprint),
        }]
    }

    #[test]
    fn binds_cosmetic_recognition_to_selected_identity_and_stock_version() {
        let stock = catalog("G28\nM500");
        let changed = " G28 ; home\n M500 ; save";
        let valid = review(
            Some(&identity()),
            &[identity()],
            "machine_start_gcode",
            changed,
            &stock,
        );
        assert_eq!(valid.decision, "cosmetic");
        assert_eq!(valid.stock_version.as_deref(), Some("1.0"));
        assert!(valid.ignored.contains(&"comments"));
        assert_eq!(
            review(None, &[identity()], "machine_start_gcode", changed, &stock).decision,
            "review"
        );
        for bad in [
            Identity {
                model: "other".into(),
                ..identity()
            },
            Identity {
                firmware: "unknown".into(),
                ..identity()
            },
        ] {
            assert_eq!(
                review(Some(&bad), &[], "machine_start_gcode", changed, &stock).decision,
                "review"
            );
            assert_eq!(
                review(Some(&identity()), &[bad], "machine_start_gcode", changed, &stock).reason,
                "printer_identity_conflict"
            );
        }
        assert_eq!(
            review(Some(&identity()), &[], "machine_end_gcode", changed, &stock).decision,
            "review"
        );
    }

    #[test]
    fn exact_path_preserves_stock_scripts_that_cannot_be_normalized() {
        let text = "M118 printer ready\nM500";
        let stock = catalog(text);
        assert_eq!(
            review(Some(&identity()), &[], "machine_start_gcode", text, &stock).decision,
            "exact"
        );
        assert_eq!(
            review(
                Some(&identity()),
                &[],
                "machine_start_gcode",
                &format!("{text} ; changed"),
                &stock
            )
            .decision,
            "review"
        );
    }

    #[test]
    fn a_stock_m500_does_not_allow_changed_or_repeated_commands() {
        let stock = catalog("G28\nM500");
        for text in [
            "M500\nG28",
            "G28\nM500\nM500",
            "G28\nM500 S1",
            "{if enabled}\nG28\nM500",
        ] {
            assert_eq!(
                review(Some(&identity()), &[], "machine_start_gcode", text, &stock).decision,
                "review"
            );
        }
    }
}
