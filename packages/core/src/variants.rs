// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
use crate::error::{Error, Result};
use crate::par::Init as _;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::OnceLock;

type Settings = Map<String, Value>;

#[derive(Clone, Copy)]
enum Scope {
    Process,
    Filament,
}

fn scope(key: &str) -> Option<Scope> {
    static PROCESS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    static FILAMENT: OnceLock<HashSet<&'static str>> = OnceLock::new();
    if crate::preflight::is_never_imported(key) {
        return None;
    }
    if matches!(
        key,
        "print_extruder_id"
            | "print_extruder_variant"
            | "filament_self_index"
            | "filament_extruder_variant"
            | "printer_extruder_id"
            | "printer_extruder_variant"
    ) {
        return None;
    }
    if PROCESS
        .once(|| {
            include_str!(concat!(env!("OUT_DIR"), "/variant_process_keys.txt"))
                .lines()
                .collect()
        })
        .contains(key)
    {
        Some(Scope::Process)
    } else if FILAMENT
        .once(|| {
            include_str!(concat!(env!("OUT_DIR"), "/variant_filament_keys.txt"))
                .lines()
                .collect()
        })
        .contains(key)
    {
        Some(Scope::Filament)
    } else {
        None
    }
}

pub(crate) fn has_tables(raw: &Settings) -> bool {
    raw.contains_key("print_extruder_variant") || raw.contains_key("filament_extruder_variant")
}

fn list(raw: &Settings, key: &str) -> Vec<String> {
    raw.get(key).and_then(Value::as_array).map_or_else(Vec::new, |a| {
        a.iter()
            .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned))
            .collect()
    })
}

fn invalid(reason: impl Into<String>) -> Error {
    Error::Config {
        key: "project_variants",
        reason: reason.into(),
    }
}

fn identity(id: &str) -> Result<usize> {
    if id.starts_with('0') || id.is_empty() || !id.bytes().all(|c| c.is_ascii_digit()) {
        return Err(invalid(format!("invalid variant identity {id}")));
    }
    id.parse()
        .map_err(|_| invalid(format!("invalid variant identity {id}")))
}

struct Tables {
    ids: Vec<String>,
    process: Vec<String>,
    filament: Vec<String>,
    owners: Vec<String>,
    types: Vec<String>,
    volumes: Vec<String>,
    map: Vec<String>,
    extruders: Vec<String>,
    physical: usize,
    filaments: usize,
}

impl Tables {
    fn new(raw: &Settings) -> Self {
        let ids = list(raw, "print_extruder_id");
        let mut extruders = ids.clone();
        extruders.sort();
        extruders.dedup();
        extruders.sort_by_key(|s| s.parse::<usize>().unwrap_or(usize::MAX));
        let types = list(raw, "extruder_type");
        let volumes = list(raw, "nozzle_volume_type");
        let physical = types
            .len()
            .max(volumes.len())
            .max(list(raw, "nozzle_diameter").len())
            .max(1);
        Self {
            ids,
            extruders,
            types,
            volumes,
            physical,
            process: list(raw, "print_extruder_variant"),
            filament: list(raw, "filament_extruder_variant"),
            owners: list(raw, "filament_self_index"),
            map: list(raw, "filament_map"),
            filaments: list(raw, "filament_settings_id")
                .len()
                .max(list(raw, "filament_colour").len()),
        }
    }

    fn active(&self, e: usize) -> String {
        let kind = self
            .types
            .get(e)
            .or_else(|| self.types.first())
            .map_or("Direct Drive", String::as_str);
        let volume = self
            .volumes
            .get(e)
            .or_else(|| self.volumes.first())
            .map_or("Standard", String::as_str);
        format!("{kind} {volume}")
    }

    fn expanded(&self, key: &str, value: &Value) -> Option<Scope> {
        let n = value.as_array()?.len();
        match scope(key)? {
            Scope::Process if self.process.len() > self.extruders.len() && n == self.process.len() => {
                Some(Scope::Process)
            }
            Scope::Filament
                if self.filaments > 0 && self.filament.len() > self.filaments && n == self.filament.len() =>
            {
                Some(Scope::Filament)
            }
            _ => None,
        }
    }

    fn matching(names: &[String], owners: &[String], owner: &str, variant: &str) -> Result<usize> {
        let found: Vec<usize> = names
            .iter()
            .enumerate()
            .filter_map(|(i, name)| {
                (name == variant && owners.get(i).is_some_and(|id| id == owner)).then_some(i)
            })
            .collect();
        if found.len() != 1 {
            return Err(invalid(format!(
                "identity {owner} needs exactly one {variant} entry; found {}",
                found.len()
            )));
        }
        found
            .first()
            .copied()
            .ok_or_else(|| invalid("missing variant match"))
    }

    fn process_indices(&self) -> Result<Vec<usize>> {
        if self.extruders.is_empty() || self.ids.len() != self.process.len() {
            return Err(invalid(
                "process variant identities are missing or have different lengths",
            ));
        }
        self.extruders
            .iter()
            .enumerate()
            .map(|(e, id)| {
                if identity(id)? != e + 1 || e >= self.physical {
                    return Err(invalid(
                        "process variant identities must cover contiguous physical extruders",
                    ));
                }
                Self::matching(&self.process, &self.ids, id, &self.active(e))
            })
            .collect()
    }

    fn filament_owners(&self) -> Result<Vec<String>> {
        if !self.owners.is_empty() {
            if self.owners.len() != self.filament.len() {
                return Err(invalid(
                    "filament_self_index and filament_extruder_variant have different lengths",
                ));
            }
            return self
                .owners
                .iter()
                .map(|id| {
                    let n = identity(id)?;
                    if n > self.filaments {
                        return Err(invalid(format!("filament identity {id} has no filament slot")));
                    }
                    Ok(n.to_string())
                })
                .collect();
        }
        if self.filaments == 0 || !self.filament.len().is_multiple_of(self.filaments) {
            return Err(invalid(
                "filament variants need explicit identities for unequal groups",
            ));
        }
        let per = self.filament.len() / self.filaments;
        let mut expected: Option<Vec<&String>> = None;
        for group in self.filament.chunks(per.max(1)) {
            let mut names: Vec<&String> = group.iter().collect();
            names.sort();
            if names.windows(2).any(|pair| pair.first() == pair.get(1)) {
                return Err(invalid("legacy filament variants contain duplicate names"));
            }
            match &expected {
                Some(first) if first != &names => {
                    return Err(invalid("legacy filament variant groups do not match"));
                }
                None => expected = Some(names),
                _ => {}
            }
        }
        Ok((0..self.filament.len())
            .map(|i| (i / per.max(1) + 1).to_string())
            .collect())
    }

    fn filament_indices(&self) -> Result<Vec<usize>> {
        let owners = self.filament_owners()?;
        (0..self.filaments)
            .map(|f| {
                let e = if self.map.is_empty() {
                    if (0..self.physical).any(|e| self.active(e) != self.active(0)) {
                        return Err(invalid(
                            "filament_map is required when extruders have different variants",
                        ));
                    }
                    0
                } else {
                    let e = identity(self.map.get(f).map_or("", String::as_str))? - 1;
                    if e >= self.physical {
                        return Err(invalid(format!(
                            "filament {} maps to unavailable extruder {}",
                            f + 1,
                            e + 1
                        )));
                    }
                    e
                };
                Self::matching(&self.filament, &owners, &(f + 1).to_string(), &self.active(e))
            })
            .collect()
    }
}

pub(crate) fn sources(raw: &Settings) -> Settings {
    let tables = Tables::new(raw);
    raw.iter()
        .filter(|(k, v)| tables.expanded(k, v).is_some())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

pub(crate) fn select(raw: &Settings) -> Result<Settings> {
    let tables = Tables::new(raw);
    let mut process = None;
    let mut filament = None;
    let mut out = Settings::new();
    for (key, value) in raw {
        let Some(scope) = tables.expanded(key, value) else {
            continue;
        };
        let indices = match scope {
            Scope::Process => {
                if process.is_none() {
                    process = Some(tables.process_indices()?);
                }
                process.as_ref()
            }
            Scope::Filament => {
                if filament.is_none() {
                    filament = Some(tables.filament_indices()?);
                }
                filament.as_ref()
            }
        }
        .ok_or_else(|| invalid("missing variant selection"))?;
        let values = value
            .as_array()
            .ok_or_else(|| invalid("variant values must be an array"))?;
        let selected = indices
            .iter()
            .map(|&i| {
                values
                    .get(i)
                    .cloned()
                    .ok_or_else(|| invalid("variant value is missing"))
            })
            .collect::<Result<Vec<_>>>()?;
        out.insert(key.clone(), Value::Array(selected));
    }
    Ok(out)
}
