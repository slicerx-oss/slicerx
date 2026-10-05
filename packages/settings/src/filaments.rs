// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Filament presets per brand: the values of the makers' own filament profiles (Bambu Studio's for Bambu Lab,
//! `OrcaSlicer`'s for the rest), as facts. `packages/profiles/filaments/<vendor>.json` holds one file per vendor folder.
//! The files are not compiled in (they are megabytes); the caller reads one and passes its text to
//! [`VendorFile::parse`]. `js/filaments.ts` does the same.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Map, Value as Json};

use crate::import::import_orca;
use crate::value::PrintConfig;

#[derive(Debug, Clone, Deserialize)]
pub struct FamilyEntry {
    pub base: Map<String, Json>,
    pub variants: BTreeMap<String, Map<String, Json>>,
}

/// One vendor's preset file.
#[derive(Debug, Clone, Deserialize)]
pub struct VendorFile {
    pub source: String,
    pub commit: String,
    pub vendor: String,
    /// Presets `OrcaSlicer` 2.4.2 does not have, by profile name, with the source their values come from.
    #[serde(default)]
    pub fallback: BTreeMap<String, String>,
    pub common: Map<String, Json>,
    pub families: BTreeMap<String, FamilyEntry>,
}

#[derive(Debug, Clone)]
pub struct FilamentPreset {
    pub vendor: String,
    pub family: String,
    pub variant: String,
    /// The profile name, such as `Bambu PLA Basic @BBL X1C`.
    pub name: String,
    pub brand: String,
    pub material: String,
    /// The maker's material id (the AMS id for Bambu Lab).
    pub filament_id: String,
    /// Settings the schema knows, typed.
    pub config: PrintConfig,
    /// Keys only some slicers define, in the profile's own value format.
    pub extras: Map<String, Json>,
    pub compatible_printers: Vec<String>,
    /// Which app's profile the values come from, and its commit.
    pub source: (String, String),
}

impl VendorFile {
    /// Reads a vendor file. `None` when the text is not one.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        serde_json::from_str(text).ok()
    }

    /// Which app's profile a preset's values come from, and its commit.
    fn source_of(&self, name: &str) -> (String, String) {
        match self.fallback.get(name).and_then(|s| s.rsplit_once(' ')) {
            Some((app, commit)) => (app.to_owned(), commit.to_owned()),
            None => (self.source.clone(), self.commit.clone()),
        }
    }

    /// The merged values of one preset in the profile's own format: common, then the product, then the variant.
    #[must_use]
    pub fn raw(&self, family: &str, variant: &str) -> Option<Map<String, Json>> {
        let fam = self.families.get(family)?;
        let diff = fam.variants.get(variant)?;
        let mut out = self.common.clone();
        for (k, v) in &fam.base {
            out.insert(k.clone(), v.clone());
        }
        for (k, v) in diff {
            if v.is_null() {
                out.remove(k);
            } else {
                out.insert(k.clone(), v.clone());
            }
        }
        Some(out)
    }

    /// A preset. `variant` defaults to the product's first one.
    #[must_use]
    pub fn preset(&self, family: &str, variant: Option<&str>) -> Option<FilamentPreset> {
        let fam = self.families.get(family)?;
        let v = variant
            .map(str::to_owned)
            .or_else(|| fam.variants.keys().next().cloned())?;
        let raw = self.raw(family, &v)?;
        let imported = import_orca(&Json::Object(raw.clone()), &|_| None).ok()?;
        let mut extras = Map::new();
        for k in imported
            .unknown_keys
            .iter()
            .chain(&imported.ignored_keys)
            .chain(&imported.invalid_keys)
        {
            if let Some(x) = raw.get(k) {
                extras.insert(k.clone(), x.clone());
            }
        }
        let first = |k: &str| -> String {
            match raw.get(k) {
                Some(Json::Array(a)) => a.first().and_then(Json::as_str).unwrap_or("").to_owned(),
                Some(Json::String(s)) => s.clone(),
                _ => String::new(),
            }
        };
        let name = if v.is_empty() {
            family.to_owned()
        } else {
            format!("{family} @{v}")
        };
        let compatible_printers = match raw.get("compatible_printers") {
            Some(Json::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect(),
            _ => Vec::new(),
        };
        Some(FilamentPreset {
            vendor: self.vendor.clone(),
            family: family.to_owned(),
            name: name.clone(),
            variant: v,
            brand: first("filament_vendor"),
            material: first("filament_type"),
            filament_id: first("filament_id"),
            config: imported.config,
            extras,
            compatible_printers,
            source: self.source_of(&name),
        })
    }
}
