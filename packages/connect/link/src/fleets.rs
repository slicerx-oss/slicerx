// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Fleets: optional user-defined groups of printers. A printer can be in any number of them and
//! deleting a fleet never removes printers. Saved with the hub's state.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Fleet {
    pub id: String,
    pub name: String,
    pub printer_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// Why a fleet call failed, mapped to an error code by the caller.
#[derive(Debug)]
pub(crate) enum FleetError {
    /// The fleet or a printer does not exist.
    NotFound(String),
    /// The name is empty or already used.
    Invalid(String),
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub(crate) struct Fleets {
    list: Vec<Fleet>,
    counter: u64,
}

impl Fleets {
    pub(crate) fn all(&self) -> Vec<Fleet> {
        self.list.clone()
    }

    fn unique_name(&self, name: &str, own: Option<&str>) -> Result<String, FleetError> {
        let clean = name.trim();
        if clean.is_empty() {
            return Err(FleetError::Invalid("A fleet needs a name".to_owned()));
        }
        if self
            .list
            .iter()
            .any(|f| Some(f.id.as_str()) != own && f.name.eq_ignore_ascii_case(clean))
        {
            return Err(FleetError::Invalid(format!(
                "A fleet named {clean} already exists"
            )));
        }
        Ok(clean.to_owned())
    }

    fn get_mut(&mut self, id: &str) -> Result<&mut Fleet, FleetError> {
        self.list
            .iter_mut()
            .find(|f| f.id == id)
            .ok_or_else(|| FleetError::NotFound(format!("no fleet {id}")))
    }

    /// `known` says whether a printer id exists.
    pub(crate) fn create(
        &mut self,
        name: &str,
        color: Option<String>,
        icon: Option<String>,
        printer_ids: Vec<String>,
        known: &dyn Fn(&str) -> bool,
    ) -> Result<Fleet, FleetError> {
        let name = self.unique_name(name, None)?;
        let mut ids: Vec<String> = Vec::new();
        for id in printer_ids {
            if !known(&id) {
                return Err(FleetError::NotFound(format!("no printer {id}")));
            }
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        self.counter += 1;
        let fleet = Fleet {
            id: format!("fleet-{}", self.counter),
            name,
            printer_ids: ids,
            color,
            icon,
        };
        self.list.push(fleet.clone());
        Ok(fleet)
    }

    pub(crate) fn rename(&mut self, id: &str, name: &str) -> Result<Fleet, FleetError> {
        let name = self.unique_name(name, Some(id))?;
        let f = self.get_mut(id)?;
        f.name = name;
        Ok(f.clone())
    }

    /// `patch` members present set the value, `null` clears it, absent members stay.
    pub(crate) fn update(&mut self, id: &str, patch: &Value) -> Result<Fleet, FleetError> {
        let f = self.get_mut(id)?;
        let apply = |slot: &mut Option<String>, key: &str| {
            if let Some(v) = patch.get(key) {
                *slot = v.as_str().map(str::to_owned);
            }
        };
        apply(&mut f.color, "color");
        apply(&mut f.icon, "icon");
        Ok(f.clone())
    }

    pub(crate) fn delete(&mut self, id: &str) -> Result<(), FleetError> {
        self.get_mut(id)?;
        self.list.retain(|f| f.id != id);
        Ok(())
    }

    pub(crate) fn add(
        &mut self,
        id: &str,
        printer: &str,
        known: &dyn Fn(&str) -> bool,
    ) -> Result<Fleet, FleetError> {
        let f = self.get_mut(id)?;
        if !known(printer) {
            return Err(FleetError::NotFound(format!("no printer {printer}")));
        }
        if !f.printer_ids.iter().any(|p| p == printer) {
            f.printer_ids.push(printer.to_owned());
        }
        Ok(f.clone())
    }

    pub(crate) fn remove(&mut self, id: &str, printer: &str) -> Result<Fleet, FleetError> {
        let f = self.get_mut(id)?;
        f.printer_ids.retain(|p| p != printer);
        Ok(f.clone())
    }

    /// Called when a printer is removed from the bridge.
    pub(crate) fn forget_printer(&mut self, printer: &str) {
        for f in &mut self.list {
            f.printer_ids.retain(|p| p != printer);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known(id: &str) -> bool {
        id.starts_with("bay-")
    }

    fn code(e: &FleetError) -> &'static str {
        match e {
            FleetError::NotFound(_) => "not_found",
            FleetError::Invalid(_) => "protocol",
        }
    }

    #[test]
    fn groups_are_optional_and_overlapping() {
        let mut f = Fleets::default();
        let a = f
            .create(
                " Bench ",
                Some("cyan".into()),
                None,
                vec!["bay-1".into(), "bay-1".into()],
                &known,
            )
            .unwrap();
        assert_eq!((a.name.as_str(), a.printer_ids.len()), ("Bench", 1));
        let b = f.create("Enclosed", None, None, vec![], &known).unwrap();
        f.add(&b.id, "bay-1", &known).unwrap();
        assert_eq!(f.add(&b.id, "bay-1", &known).unwrap().printer_ids, vec!["bay-1"]);
        assert_eq!(f.remove(&a.id, "bay-1").unwrap().printer_ids.len(), 0);
        assert_eq!(
            f.all()
                .iter()
                .filter(|x| x.printer_ids.contains(&"bay-1".to_owned()))
                .count(),
            1
        );
        f.forget_printer("bay-1");
        assert!(f.all().iter().all(|x| x.printer_ids.is_empty()));
    }

    #[test]
    fn names_and_ids_are_validated() {
        let mut f = Fleets::default();
        let a = f.create("Bench", None, None, vec![], &known).unwrap();
        assert_eq!(
            code(&f.create("  ", None, None, vec![], &known).unwrap_err()),
            "protocol"
        );
        assert_eq!(
            code(&f.create("BENCH", None, None, vec![], &known).unwrap_err()),
            "protocol"
        );
        assert_eq!(
            code(
                &f.create("X", None, None, vec!["nope".into()], &known)
                    .unwrap_err()
            ),
            "not_found"
        );
        assert_eq!(code(&f.rename("nope", "Y").unwrap_err()), "not_found");
        assert!(
            f.rename(&a.id, "bench").is_ok(),
            "renaming to its own name in another case is fine"
        );
        assert_eq!(code(&f.add(&a.id, "nope", &known).unwrap_err()), "not_found");
        f.update(&a.id, &serde_json::json!({ "color": "red", "icon": "printer" }))
            .unwrap();
        let cleared = f.update(&a.id, &serde_json::json!({ "color": null })).unwrap();
        assert_eq!((cleared.color, cleared.icon.as_deref()), (None, Some("printer")));
        f.delete(&a.id).unwrap();
        assert_eq!(code(&f.delete(&a.id).unwrap_err()), "not_found");
    }
}
