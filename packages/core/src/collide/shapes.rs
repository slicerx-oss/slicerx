// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The heads, racks and docks Preview draws, as `packages/ui/viewport/test/head-shapes.test.ts` writes them: each
//! head as columns around its active nozzle, each tool change as the stops the head makes.

use serde_json::Value;
use std::sync::OnceLock;

const SHAPES: &str = include_str!(concat!(env!("OUT_DIR"), "/head-shapes.json"));

/// A box around the nozzle tip, `[x0, x1] x [y0, y1]`, standing from `z0` up to the carriage, mm.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Column {
    pub x: [f64; 2],
    pub y: [f64; 2],
    pub z0: f64,
}

/// One stop of a tool change: where the head goes, how far above the print's top, and whether it is at the
/// rack, dock or switch bay itself rather than on the way there.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Stop {
    pub x: f64,
    pub y: f64,
    pub dz: f64,
    pub station: bool,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Changer {
    /// `toolChangerSpec`'s kind: dual-nozzle, hotend-rack, tool-rack, xl-dock, lift-switch, filament-swap.
    pub kind: String,
    /// How far the head lifts over the print for the change, mm.
    pub lift_mm: f64,
    /// Each change's stops by its tools, `from-to` as the file writes them.
    routes: Vec<(String, Vec<Stop>)>,
}

impl Changer {
    /// The stops of a change from tool `from` to `to` (0-based); a change kept once stands for all.
    pub(crate) fn route(&self, from: usize, to: usize) -> &[Stop] {
        let key = format!("{from}-{to}");
        let find = |k: &str| self.routes.iter().find(|(r, _)| r == k);
        find(&key)
            .or_else(|| find("0-1"))
            .map_or(&[], |(_, s)| s.as_slice())
    }

    /// What the head goes to, for messages.
    pub(crate) fn station(&self) -> &'static str {
        match self.kind.as_str() {
            "hotend-rack" => "hotend rack",
            "tool-rack" | "xl-dock" => "tool dock",
            "lift-switch" => "switch bay",
            _ => "purge chute",
        }
    }
}

/// The machine around the nozzle: the head of each extruder and the tool changer.
#[derive(Debug, Clone, Default)]
pub(crate) struct Machine {
    pub heads: Vec<Vec<Column>>,
    pub changer: Option<Changer>,
}

fn file() -> &'static Value {
    static FILE: OnceLock<Value> = OnceLock::new();
    crate::par::Init::once(&FILE, || serde_json::from_str(SHAPES).unwrap_or_default())
}

/// The numbers of a JSON list, 0 where one is missing.
fn numbers(v: &Value) -> Vec<f64> {
    v.as_array()
        .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect())
        .unwrap_or_default()
}

fn columns(f: &Value, key: &str) -> Vec<Column> {
    f.get("heads")
        .and_then(|h| h.get(key))
        .and_then(Value::as_array)
        .map(|cols| {
            cols.iter()
                .filter_map(|c| match numbers(c).as_slice() {
                    &[x0, x1, y0, y1, z0] => Some(Column {
                        x: [x0, x1],
                        y: [y0, y1],
                        z0,
                    }),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn changer(c: &Value) -> Changer {
    let routes = c
        .get("routes")
        .and_then(Value::as_object)
        .map(|r| {
            r.iter()
                .map(|(k, stops)| {
                    let stops = stops
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|s| match numbers(s).as_slice() {
                                    &[x, y, dz, station] => Some(Stop {
                                        x,
                                        y,
                                        dz,
                                        station: station > 0.5,
                                    }),
                                    _ => None,
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    (k.clone(), stops)
                })
                .collect()
        })
        .unwrap_or_default();
    Changer {
        kind: c
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        lift_mm: c.get("liftMm").and_then(Value::as_f64).unwrap_or(3.0),
        routes,
    }
}

/// The machine for a printer profile id (`bambu-h2d`), else for the profile's `printer_model`, else the generic
/// head Preview draws for printers it does not know.
pub(crate) fn machine(printer_id: Option<&str>, printer_model: Option<&str>) -> Machine {
    let f = file();
    let printers = f.get("printers");
    let by_model = printer_model.and_then(|m| f.get("models")?.get(m)?.as_str());
    let Some(p) = [printer_id, by_model]
        .into_iter()
        .flatten()
        .find_map(|id| printers?.get(id))
    else {
        return Machine {
            heads: vec![columns(f, "generic")],
            changer: None,
        };
    };
    let heads = p
        .get("heads")
        .and_then(Value::as_array)
        .map(|h| {
            h.iter()
                .filter_map(Value::as_str)
                .map(|k| columns(f, k))
                .collect()
        })
        .unwrap_or_default();
    let changer = p
        .get("changer")
        .and_then(Value::as_str)
        .and_then(|k| f.get("changers")?.get(k))
        .map(changer);
    Machine { heads, changer }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_printer_has_a_head_with_a_nozzle_at_the_tip() {
        let printers = file()["printers"].as_object().expect("head-shapes.json parses");
        assert!(printers.len() > 40);
        for id in printers.keys() {
            let m = machine(Some(id), None);
            assert!(!m.heads.is_empty(), "{id}");
            for h in &m.heads {
                assert!(
                    h.iter().any(|c| c.z0 < 0.01 && c.x[0] <= 0.0 && c.x[1] >= 0.0),
                    "{id}"
                );
            }
        }
    }

    #[test]
    fn the_toolchangers_carry_their_routes() {
        let h2d = machine(Some("bambu-h2d"), None);
        assert_eq!(h2d.heads.len(), 2);
        let ch = h2d.changer.expect("H2D changes at the chute");
        assert_eq!(ch.kind, "dual-nozzle");
        assert!(ch.route(1, 0).first().is_some_and(|s| s.y > 320.0));
        let u1 = machine(None, Some("Snapmaker U1"));
        let ch = u1.changer.expect("U1 docks its tools");
        assert_eq!(ch.kind, "tool-rack");
        // the U1's dock stops are behind the bed
        assert!(ch.route(0, 2).iter().any(|s| s.station && s.y > 300.0));
        assert!(machine(Some("nobody"), None).changer.is_none());
    }
}
