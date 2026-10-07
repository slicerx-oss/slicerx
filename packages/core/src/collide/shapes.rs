// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The heads, racks and docks Preview draws, as `packages/ui/viewport/test/head-shapes.test.ts` writes them: each
//! head as columns around its active nozzle, each tool change as the stops the head makes.

use serde_json::Value;
use std::sync::OnceLock;

const SHAPES: &str = include_str!(concat!(env!("OUT_DIR"), "/head-shapes.json"));

/// A box around the nozzle tip, `[x0, x1] x [y0, y1]`, from its underside `z0` to its top `z1`, mm.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Column {
    pub x: [f64; 2],
    pub y: [f64; 2],
    pub z0: f64,
    pub z1: f64,
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

/// The list at `v`, empty when it is not one.
fn list(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// The `N` numbers of a JSON list, or none when it holds another count.
fn numbers<const N: usize>(v: &Value) -> Option<[f64; N]> {
    let a = list(Some(v));
    let mut out = [0.0; N];
    if a.len() != N {
        return None;
    }
    for (o, x) in out.iter_mut().zip(a) {
        *o = x.as_f64().unwrap_or(0.0);
    }
    Some(out)
}

fn columns(f: &Value, key: &str) -> Vec<Column> {
    let mut out = Vec::new();
    for c in list(f.get("heads").and_then(|h| h.get(key))) {
        // a file from before the boxes had tops stands them up forever
        let box6 = numbers::<6>(c)
            .or_else(|| numbers::<5>(c).map(|[x0, x1, y0, y1, z0]| [x0, x1, y0, y1, z0, f64::INFINITY]));
        if let Some([x0, x1, y0, y1, z0, z1]) = box6 {
            out.push(Column {
                x: [x0, x1],
                y: [y0, y1],
                z0,
                z1,
            });
        }
    }
    out
}

fn changer(c: &Value) -> Changer {
    let mut routes = Vec::new();
    if let Some(r) = c.get("routes").and_then(Value::as_object) {
        for (k, stops) in r {
            let mut route = Vec::new();
            for s in list(Some(stops)) {
                if let Some([x, y, dz, station]) = numbers(s) {
                    route.push(Stop {
                        x,
                        y,
                        dz,
                        station: station > 0.5,
                    });
                }
            }
            routes.push((k.clone(), route));
        }
    }
    Changer {
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
    let Some(p) = printers.and_then(|ps| {
        printer_id
            .and_then(|id| ps.get(id))
            .or_else(|| by_model.and_then(|id| ps.get(id)))
    }) else {
        return Machine {
            heads: vec![columns(f, "generic")],
            changer: None,
        };
    };
    let mut heads = Vec::new();
    for k in list(p.get("heads")) {
        if let Some(k) = k.as_str() {
            heads.push(columns(f, k));
        }
    }
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
        assert!(ch.route(1, 0).first().is_some_and(|s| s.y > 320.0));
        let u1 = machine(None, Some("Snapmaker U1"));
        let ch = u1.changer.expect("U1 docks its tools");
        // the U1's dock stops are behind the bed
        assert!(ch.route(0, 2).iter().any(|s| s.station && s.y > 300.0));
        assert!(machine(Some("nobody"), None).changer.is_none());
    }
}
