// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Which nozzle prints each filament on a Bambu Lab printer with two extruders, each fed by its own
//! AMS (H2D, and the H2C with its hotend rack on the right): Bambu Studio's filament map.
//!
//! - `filament_map_mode` `Manual` (or `Nozzle Manual`) takes `filament_map` as given: the extruder of each
//!   filament, 1 the left and 2 the right.
//! - Anything else (`Auto For Flush`, the default) picks the map with the least waste, as Bambu Studio
//!   maps them: every split of the plate's filaments between the two extruders is tried, each layer printed
//!   one extruder's filaments after the other's, and the split scores its flush volume (as seconds of
//!   flushing) plus the seconds its changes take. A filament whose parts reach past an extruder's printable area stays off that extruder; the
//!   master extruder gets a small penalty when it ends up with fewer than half the filaments; on a tie the
//!   first split in Bambu Studio's enumeration order wins. Only the filaments the plate prints with take part
//!   (a part whose features all print with other filaments leaves its own filament out); the others go to the
//!   left extruder.
//! - On the H2C each filament of the right extruder gets a hotend of its own from the rack while there are
//!   hotends (`extruder_max_nozzle_count`), so changes between them are hotend swaps and flush nothing.
//!
//! Printers with one tool per filament (the Snapmaker U1, the Prusa XL, `UltiMaker`) need no map: filament
//! `n` is tool `n`. Printers with one nozzle have nothing to map.

use crate::config::PrintConfig;

/// The weight of a flushed mm3 against a second of change time, as Bambu Studio weighs them: 1.26 g/cm3 at
/// 180 s/g, doubled.
const FLUSH_SCORE: f64 = 1.26 * 180.0 * 2.0 / 1000.0;

/// The penalty, in seconds of score, when the master extruder prints fewer than half the filaments, as Bambu Studio
/// adds it.
const MASTER_PENALTY: f64 = 10.0;

/// Most filaments the splits are enumerated for; past this a split is improved one filament at a time.
const ENUM_MAX: usize = 12;

/// The filament map of a plate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Map {
    /// The extruder (0-based) of each filament slot, index slot - 1.
    pub extruder: Vec<u8>,
    /// The nozzle of each filament slot: the left extruder's nozzle is 0, the right extruder's nozzles
    /// (the H2C rack's hotends) follow from 1.
    pub nozzle: Vec<u8>,
    /// True when the engine picked the map (`filament_map_mode` auto).
    pub auto: bool,
}

/// A Bambu Lab printer with two extruders, each with its own filament feed: filaments share an extruder
/// through the AMS and the map decides which.
pub(crate) fn shared(cfg: &PrintConfig) -> bool {
    extruders(cfg) > 1
        && crate::tower::type1(cfg)
        && crate::tower::flag_or(cfg, "single_extruder_multi_material", true)
}

/// The printer's extruders (`nozzle_diameter` entries).
pub(crate) fn extruders(cfg: &PrintConfig) -> usize {
    match cfg.raw.get("nozzle_diameter") {
        Some(serde_json::Value::Array(a)) => a.len().max(1),
        _ => 1,
    }
}

/// Nozzles each extruder can hold (`extruder_max_nozzle_count`; the H2C's right extruder takes six).
fn nozzle_counts(cfg: &PrintConfig, extruders: usize) -> Vec<usize> {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a nozzle count"
    )]
    (0..extruders)
        .map(|e| {
            let slot = u8::try_from(e + 1).unwrap_or(1);
            match cfg.raw.get("extruder_max_nozzle_count") {
                Some(serde_json::Value::Array(a)) if a.len() > e => {
                    crate::tower::per_slot_raw(cfg, "extruder_max_nozzle_count", slot, 1.0)
                        .round()
                        .max(1.0) as usize
                }
                _ => 1,
            }
        })
        .collect()
}

/// How many filaments the project has: the longest of its per-filament lists that name filaments
/// (`filament_colour`, `filament_settings_id`, `filament_type`), at least 1. The map lists every one of them,
/// the ones the plate never prints with too, as Bambu Studio writes it.
pub fn project_filaments(cfg: &PrintConfig) -> u8 {
    ["filament_colour", "filament_settings_id", "filament_type"]
        .iter()
        .filter_map(|k| match cfg.raw.get(*k) {
            Some(serde_json::Value::Array(a)) => Some(a.len()),
            _ => None,
        })
        .max()
        .map_or(1, |n| u8::try_from(n.clamp(1, 64)).unwrap_or(64))
}

/// The master extruder, 0-based (`master_extruder_id`, 1-based in the profile).
fn master(cfg: &PrintConfig, extruders: usize) -> usize {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "an extruder number"
    )]
    let m = cfg.raw_number("master_extruder_id", 1.0).round().max(1.0) as usize - 1;
    m.min(extruders - 1)
}

/// The printable box `[min x, min y, max x, max y]` of each extruder (`extruder_printable_area`), when
/// the profile gives one per extruder.
pub(crate) fn reach_boxes(cfg: &PrintConfig, extruders: usize) -> Vec<Option<[f64; 4]>> {
    let num = |v: &serde_json::Value| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|t| t.trim().parse().ok()))
    };
    let area = match cfg.raw.get("extruder_printable_area") {
        Some(serde_json::Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    (0..extruders)
        .map(|e| {
            let pts: Vec<[f64; 2]> = match area.get(e)? {
                serde_json::Value::Array(p) => p
                    .iter()
                    .filter_map(|q| match q {
                        serde_json::Value::Array(xy) => Some([num(xy.first()?)?, num(xy.get(1)?)?]),
                        serde_json::Value::String(s) => {
                            let (x, y) = s.split_once('x')?;
                            Some([x.trim().parse().ok()?, y.trim().parse().ok()?])
                        }
                        _ => None,
                    })
                    .collect(),
                serde_json::Value::String(s) => s
                    .split(',')
                    .filter_map(|t| {
                        let (x, y) = t.split_once('x')?;
                        Some([x.trim().parse().ok()?, y.trim().parse().ok()?])
                    })
                    .collect(),
                _ => Vec::new(),
            };
            (pts.len() >= 3).then(|| {
                pts.iter().fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| {
                    [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
                })
            })
        })
        .collect()
}

/// What the plate prints, as the map reads it: the filaments of each layer (sorted, 1-based slots) and the
/// box each filament's parts cover on the bed, `[min x, min y, max x, max y]`.
#[derive(Debug, Clone, Default)]
pub struct Usage {
    pub layers: Vec<Vec<u8>>,
    pub boxes: Vec<Option<[f64; 4]>>,
}

impl Usage {
    /// The layers each filament spans, from the parts' heights on a plain layer grid (`layer_height` over
    /// `initial_layer_print_height`), with painted colors on the layers their triangles cross and the
    /// support filaments on every layer when support is on. The per-feature filaments of the objects, their parts,
    /// their modifiers and the height `ranges` count where they reach.
    pub fn of_plate(
        plate: &crate::plate::Plate,
        cfg: &PrintConfig,
        ranges: &[crate::session::HeightRange],
    ) -> Self {
        let first = cfg.initial_layer_print_height.max(0.01);
        let step = cfg.layer_height.max(0.01);
        let mut spans: Vec<(u8, f64, f64)> = Vec::new();
        let mut boxes: Vec<Option<[f64; 4]>> = Vec::new();
        let mut top = 0.0f64;
        let grow = |boxes: &mut Vec<Option<[f64; 4]>>, slot: u8, p: [f64; 3]| {
            let i = usize::from(slot.max(1) - 1);
            if boxes.len() <= i {
                boxes.resize(i + 1, None);
            }
            if let Some(b) = boxes.get_mut(i) {
                let o = b.get_or_insert([f64::MAX, f64::MAX, f64::MIN, f64::MIN]);
                *o = [o[0].min(p[0]), o[1].min(p[1]), o[2].max(p[0]), o[3].max(p[1])];
            }
        };
        // The world box of a volume, `[min x, min y, min z, max x, max y, max z]`.
        let bounds = |tr: &[f32; 16], mesh: &crate::mesh::Mesh| {
            let mut b = [f64::MAX, f64::MAX, f64::MAX, f64::MIN, f64::MIN, f64::MIN];
            for part in mesh.parts.iter().filter(|p| !p.triangles.is_empty()) {
                for &v in &part.positions {
                    let p = crate::plate::PlateObject::apply_with(tr, v);
                    b = [
                        b[0].min(p[0]),
                        b[1].min(p[1]),
                        b[2].min(p[2]),
                        b[3].max(p[0]),
                        b[4].max(p[1]),
                        b[5].max(p[2]),
                    ];
                }
            }
            b
        };
        for o in &plate.objects {
            // The height ranges of this object, in order: a later one wins where they overlap.
            let own_ranges: Vec<&crate::session::HeightRange> = ranges
                .iter()
                .filter(|r| r.objects.is_empty() || r.objects.contains(&o.id))
                .collect();
            let modifiers: Vec<([f64; 6], &serde_json::Value)> = o
                .volumes
                .iter()
                .filter(|v| v.role == crate::plate::VolumeRole::Modifier)
                .map(|v| {
                    (
                        bounds(v.transform.as_ref().unwrap_or(&o.transform), &v.mesh),
                        &v.settings,
                    )
                })
                .collect();
            for part in o.mesh.parts.iter().filter(|p| !p.triangles.is_empty()) {
                let slot = o.slot_for(&part.name, part.slot);
                let (mut lo, mut hi) = (f64::MAX, f64::MIN);
                let mut footprint = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
                for &v in &part.positions {
                    let p = o.apply(v);
                    lo = lo.min(p[2]);
                    hi = hi.max(p[2]);
                    footprint = [
                        footprint[0].min(p[0]),
                        footprint[1].min(p[1]),
                        footprint[2].max(p[0]),
                        footprint[3].max(p[1]),
                    ];
                }
                top = top.max(hi);
                // Each feature prints with its filament (`sparse_infill_filament_id` and the like) over the part's
                // footprint: walls on every layer, sparse infill between the shells, solid infill and the surfaces on
                // the shell layers at the bottom and the top. The part's own filament counts only for the features
                // left on it: with every feature moved to others it prints nothing. These
                // move the features of the part's own, unpainted regions; paint keeps its own filament (below).
                let (top_n, bottom_n) = cfg.shell_layers(step);
                let shell_bottom = lo + first + f64::from(bottom_n.saturating_sub(1)) * step;
                let shell_top = hi - f64::from(top_n) * step;
                let mut add = |tools: [u8; 6], z0: f64, z1: f64, area: [f64; 4]| {
                    let [outer, inner, sparse, solid, top_f, bottom_f] = tools;
                    let bands = [
                        (outer, lo, hi),
                        (inner, lo, hi),
                        (sparse, shell_bottom, shell_top),
                        (solid, lo, shell_bottom),
                        (solid, shell_top, hi),
                        (top_f, shell_top, hi),
                        (bottom_f, lo, shell_bottom),
                    ];
                    for (f, a, b) in bands {
                        let f = if f == 0 { slot } else { f };
                        let (a, b) = (a.max(z0), b.min(z1));
                        if b > a {
                            spans.push((f, a, b));
                            grow(&mut boxes, f, [area[0], area[1], 0.0]);
                            grow(&mut boxes, f, [area[2], area[3], 0.0]);
                        }
                    }
                };
                let object = |name: &str| o.settings.get(name).or_else(|| cfg.raw.get(name));
                // A part with settings of its own prints like a modifier shaped as the part: its settings over the
                // object's, and the height ranges leave it alone, as they leave a modifier.
                let part_own = o
                    .part_settings
                    .iter()
                    .find(|(n, _)| *n == part.name)
                    .map(|(_, s)| s)
                    .filter(|s| s.as_object().is_some_and(|m| !m.is_empty()));
                if let Some(s) = part_own {
                    let get = |name: &str| s.get(name).or_else(|| object(name));
                    add(crate::session::feature_slots(get, slot), lo, hi, footprint);
                } else {
                    // The object's settings, with its height ranges' per-feature filaments on top where they reach.
                    let mut cuts = vec![lo, hi];
                    for r in &own_ranges {
                        cuts.extend(
                            [r.z_from_mm, r.z_to_mm]
                                .into_iter()
                                .filter(|z| *z > lo && *z < hi),
                        );
                    }
                    cuts.sort_by(f64::total_cmp);
                    cuts.dedup();
                    for w in cuts.windows(2) {
                        let &[z0, z1] = w else { continue };
                        let mid = f64::midpoint(z0, z1);
                        let get = |name: &str| {
                            own_ranges
                                .iter()
                                .rev()
                                .filter(|r| r.z_from_mm <= mid && mid < r.z_to_mm)
                                .find_map(|r| {
                                    crate::config::RANGE_KEYS
                                        .contains(&name)
                                        .then(|| r.settings.get(name))
                                        .flatten()
                                })
                                .or_else(|| object(name))
                        };
                        add(crate::session::feature_slots(get, slot), z0, z1, footprint);
                    }
                }
                // Inside a modifier the part prints with the modifier's settings over the object's (the height
                // ranges do not reach in), over the heights and the area the two share.
                for (b, s) in &modifiers {
                    let area = [
                        footprint[0].max(b[0]),
                        footprint[1].max(b[1]),
                        footprint[2].min(b[3]),
                        footprint[3].min(b[4]),
                    ];
                    if area[2] <= area[0] || area[3] <= area[1] || b[5] <= lo || b[2] >= hi {
                        continue;
                    }
                    let get = |name: &str| s.get(name).or_else(|| object(name));
                    add(crate::session::feature_slots(get, slot), b[2], b[5], area);
                }
                for f in &part.paint {
                    let ps = f.v.map(|v| o.apply(v));
                    let (a, b) = ps
                        .iter()
                        .fold((f64::MAX, f64::MIN), |(a, b), p| (a.min(p[2]), b.max(p[2])));
                    for p in ps {
                        grow(&mut boxes, f.state.max(1), p);
                    }
                    spans.push((f.state.max(1), a, b));
                }
            }
        }
        // A plate of one filament prints its skirt with it too: the skirt runs skirt_distance past the parts and
        // their brim, so the map must keep that within the extruder's reach. (OrcaSlicer's reach check reads only the
        // objects' walls and fills, and its skirt can land out of reach.) With several filaments the skirt goes to one whose extruder reaches it (session.rs
        // `skirt_tool_at`).
        let used: Vec<usize> = boxes
            .iter()
            .enumerate()
            .filter(|(_, b)| b.is_some())
            .map(|(i, _)| i)
            .collect();
        if let [only] = used.as_slice()
            && cfg.skirt_loops > 0
            && let Some(Some(b)) = boxes.get_mut(*only)
        {
            let brim = if crate::brim::Kind::of(cfg) == crate::brim::Kind::Off {
                0.0
            } else {
                cfg.brim_width
            };
            let margin = brim + cfg.skirt_distance + f64::from(cfg.skirt_loops) * cfg.line_width;
            *b = [b[0] - margin, b[1] - margin, b[2] + margin, b[3] + margin];
        }
        if cfg.enable_support {
            for key in ["support_filament", "support_interface_filament"] {
                let s = crate::session::support_slot(cfg, key).min(64);
                if s > 0 {
                    spans.push((s, 0.0, top));
                }
            }
        }
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a layer count"
        )]
        let n = if top > first {
            ((top - first) / step).ceil() as usize + 1
        } else {
            1
        };
        let layers = (0..n)
            .map(|l| {
                #[allow(clippy::cast_precision_loss, reason = "a layer index")]
                let (z0, z1) = if l == 0 {
                    (0.0, first)
                } else {
                    (first + (l - 1) as f64 * step, first + l as f64 * step)
                };
                let mut v: Vec<u8> = spans
                    .iter()
                    .filter(|(_, a, b)| *a < z1 - 1e-9 && *b > z0 + 1e-9)
                    .map(|s| s.0)
                    .collect();
                v.sort_unstable();
                v.dedup();
                v
            })
            .collect();
        Self { layers, boxes }
    }
}

/// The extruder (0-based) that prints filament slot `slot` (1-based): its `filament_map` entry, else one
/// extruder per filament when the printer has several, else the one extruder.
pub(crate) fn extruder_of_slot(cfg: &PrintConfig, slot: u8) -> usize {
    let n = extruders(cfg);
    let f = usize::from(slot.max(1) - 1);
    int_list(cfg, "filament_map")
        .get(f)
        .map_or(if n > 1 { f } else { 0 }, |&e| {
            usize::try_from(e.max(1) - 1).unwrap_or(0)
        })
        .min(n - 1)
}

/// A list of whole numbers from the raw settings (a list, or one number, or text joined by commas).
#[allow(clippy::cast_possible_truncation, reason = "small whole numbers")]
pub(crate) fn int_list(cfg: &PrintConfig, key: &str) -> Vec<i64> {
    let num = |v: &serde_json::Value| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|t| t.trim().parse().ok()))
            .map(|f: f64| f.round() as i64)
    };
    match cfg.raw.get(key) {
        Some(serde_json::Value::Array(a)) => a.iter().filter_map(num).collect(),
        Some(serde_json::Value::String(s)) => s
            .split([',', ' '])
            .filter_map(|t| t.trim().parse::<f64>().ok())
            .map(|f| f.round() as i64)
            .collect(),
        Some(v) => num(v).into_iter().collect(),
        None => Vec::new(),
    }
}

/// Flush volumes per extruder, `[extruder][from][to]` by 0-based slot, the multiplier applied.
fn flush_tables(cfg: &PrintConfig, tools: u8, extruders: usize) -> Vec<Vec<Vec<f64>>> {
    let n = usize::from(tools);
    (0..extruders)
        .map(|e| {
            let mult =
                crate::tower::per_slot_raw(cfg, "flush_multiplier", u8::try_from(e + 1).unwrap_or(1), 1.0)
                    .max(0.0);
            (0..n)
                .map(|a| {
                    (0..n)
                        .map(|b| crate::tower::flush_block(cfg, tools, e, a, b).unwrap_or(0.0) * mult)
                        .collect()
                })
                .collect()
        })
        .collect()
}

impl Map {
    /// The map for `cfg` and what the plate prints, or `None` on a printer that needs none.
    pub fn resolve(cfg: &PrintConfig, tools: u8, usage: &Usage) -> Option<Self> {
        if !shared(cfg) || tools == 0 {
            return None;
        }
        let ext = extruders(cfg);
        let counts = nozzle_counts(cfg, ext);
        let master = master(cfg, ext);
        let n = usize::from(tools);
        let mode = cfg
            .raw
            .get("filament_map_mode")
            .and_then(|v| v.as_str())
            .unwrap_or("Auto For Flush");
        let manual = mode == "Manual" || mode == "Nozzle Manual";
        let mut used: Vec<u8> = usage
            .layers
            .iter()
            .flatten()
            .copied()
            .filter(|&s| s >= 1 && s <= tools)
            .collect();
        used.sort_unstable();
        used.dedup();
        let extruder: Vec<u8> = if manual {
            let given = int_list(cfg, "filament_map");
            (0..n)
                .map(|i| {
                    let e = given
                        .get(i)
                        .copied()
                        .unwrap_or(i64::try_from(master + 1).unwrap_or(1));
                    u8::try_from((e.max(1) - 1).min(i64::try_from(ext - 1).unwrap_or(0))).unwrap_or(0)
                })
                .collect()
        } else {
            let boxes = reach_boxes(cfg, ext);
            let allowed = |slot: u8, e: usize| -> bool {
                match (
                    usage.boxes.get(usize::from(slot.max(1) - 1)).copied().flatten(),
                    boxes.get(e).copied().flatten(),
                ) {
                    (Some(b), Some(r)) => {
                        b[0] >= r[0] - 1e-3
                            && b[1] >= r[1] - 1e-3
                            && b[2] <= r[2] + 1e-3
                            && b[3] <= r[3] + 1e-3
                    }
                    _ => true,
                }
            };
            let tables = flush_tables(cfg, tools, ext);
            let sim = Sim {
                cfg,
                tables: &tables,
                counts: &counts,
                layers: &usage.layers,
                tools,
            };
            // A filament the plate never prints with goes to the left extruder, as Bambu Studio maps it.
            let mut best_map = vec![0u8; n];
            if used.len() < 2 || ext != 2 {
                for &s in &used {
                    if let Some(m) = best_map.get_mut(usize::from(s - 1)) {
                        *m = u8::try_from(master).unwrap_or(0);
                    }
                }
                if let Some(&s) = used.first()
                    && !allowed(s, master)
                    && let Some(m) = best_map.get_mut(usize::from(s - 1))
                {
                    *m = u8::from(master == 0);
                }
                best_map
            } else {
                let k = used.len();
                let score_of = |labels: &[u8]| -> (usize, f64) {
                    let mut full = vec![u8::try_from(master).unwrap_or(0); n];
                    for (&s, &e) in used.iter().zip(labels) {
                        if let Some(f) = full.get_mut(usize::from(s - 1)) {
                            *f = e;
                        }
                    }
                    let placeable = used
                        .iter()
                        .zip(labels)
                        .filter(|&(&s, &e)| allowed(s, usize::from(e)))
                        .count();
                    let (flush, time) = sim.run(&full);
                    let on_master = labels.iter().filter(|&&e| usize::from(e) == master).count();
                    let penalty = if on_master < k.div_ceil(2) {
                        MASTER_PENALTY
                    } else {
                        0.0
                    };
                    (placeable, flush * FLUSH_SCORE + time + penalty)
                };
                // Between maps that score the same, the first in Bambu Studio's order wins, as Bambu Studio maps them
                // (filament 1 on the right, master, extruder of a two-filament H2D plate). For Bambu printers Bambu
                // Studio is the reference where it and OrcaSlicer differ; OrcaSlicer is not even consistent here.
                let better = |a: (usize, f64), b: (usize, f64)| a.0 > b.0 || (a.0 == b.0 && a.1 < b.1 - 1e-9);
                let mut best_labels: Vec<u8> = vec![u8::try_from(master).unwrap_or(0); k];
                let mut best = (0usize, f64::INFINITY);
                if k <= ENUM_MAX {
                    // Bambu Studio's order: label i of the split is digit i of the mask.
                    for mask in 0u32..(1u32 << k) {
                        let labels: Vec<u8> = (0..k).map(|i| u8::from(mask >> i & 1 == 1)).collect();
                        let s = score_of(&labels);
                        if better(s, best) {
                            best = s;
                            best_labels = labels;
                        }
                    }
                } else {
                    // One filament at a time to the other extruder while that helps.
                    best = score_of(&best_labels);
                    let mut improved = true;
                    while improved {
                        improved = false;
                        for i in 0..k {
                            let mut trial = best_labels.clone();
                            if let Some(t) = trial.get_mut(i) {
                                *t = 1 - *t;
                            }
                            let s = score_of(&trial);
                            if better(s, best) {
                                best = s;
                                best_labels = trial;
                                improved = true;
                            }
                        }
                    }
                }
                for (&s, &e) in used.iter().zip(&best_labels) {
                    if let Some(f) = best_map.get_mut(usize::from(s - 1)) {
                        *f = e;
                    }
                }
                best_map
            }
        };
        let nozzle = nozzle_ids(&extruder, &counts, &used);
        Some(Self {
            extruder,
            nozzle,
            auto: !manual,
        })
    }

    /// `cfg` with the map written where the rest of the engine and the profile's G-code read it:
    /// `filament_map` (1-based extruder per filament) and `filament_nozzle_map` (the nozzle per filament).
    pub fn apply(&self, cfg: &PrintConfig) -> PrintConfig {
        let mut c = cfg.clone();
        c.raw.insert(
            "filament_map".into(),
            serde_json::Value::Array(
                self.extruder
                    .iter()
                    .map(|&e| serde_json::json!(u32::from(e) + 1))
                    .collect(),
            ),
        );
        c.raw.insert(
            "filament_nozzle_map".into(),
            serde_json::Value::Array(self.nozzle.iter().map(|&n| serde_json::json!(n)).collect()),
        );
        c
    }

    /// The extruder (0-based) of filament slot `slot` (1-based).
    pub fn extruder_of(&self, slot: u8) -> usize {
        usize::from(
            self.extruder
                .get(usize::from(slot.max(1) - 1))
                .copied()
                .unwrap_or(0),
        )
    }

    /// The nozzle of filament slot `slot` (1-based).
    pub fn nozzle_of(&self, slot: u8) -> usize {
        usize::from(
            self.nozzle
                .get(usize::from(slot.max(1) - 1))
                .copied()
                .unwrap_or(0),
        )
    }
}

/// The nozzle of each filament: extruder 0's filaments share its nozzle; on an extruder that holds several
/// nozzles (the H2C rack) each filament takes a nozzle of its own while there are free ones, in slot
/// order, and later ones share the last.
fn nozzle_ids(extruder: &[u8], counts: &[usize], used: &[u8]) -> Vec<u8> {
    let base: Vec<usize> = counts
        .iter()
        .scan(0usize, |acc, &c| {
            let b = *acc;
            *acc += c;
            Some(b)
        })
        .collect();
    let mut taken = vec![0usize; counts.len()];
    extruder
        .iter()
        .enumerate()
        .map(|(i, &e)| {
            let e = usize::from(e);
            let start = base.get(e).copied().unwrap_or(0);
            let count = counts.get(e).copied().unwrap_or(1).max(1);
            let slot = u8::try_from(i + 1).unwrap_or(1);
            let k = if count > 1 && used.contains(&slot) {
                let t = taken.get(e).copied().unwrap_or(0);
                if let Some(c) = taken.get_mut(e) {
                    *c += 1;
                }
                t.min(count - 1)
            } else {
                0
            };
            u8::try_from(start + k).unwrap_or(0)
        })
        .collect()
}

/// A print simulated for one candidate map: the layers' filament orders and the flush and change time
/// they cost.
struct Sim<'a> {
    cfg: &'a PrintConfig,
    tables: &'a [Vec<Vec<f64>>],
    counts: &'a [usize],
    layers: &'a [Vec<u8>],
    tools: u8,
}

impl Sim<'_> {
    /// Flush mm3 and change seconds of the whole print with filament extruders `ext` (per slot).
    fn run(&self, ext: &[u8]) -> (f64, f64) {
        let mut used: Vec<u8> = self.layers.iter().flatten().copied().collect();
        used.sort_unstable();
        used.dedup();
        let nozzle = nozzle_ids(ext, self.counts, &used);
        let nozzles = self.counts.iter().sum::<usize>().max(1);
        let map: Vec<usize> = ext.iter().map(|&e| usize::from(e)).collect();
        let mut clock = crate::gcode::ChangeClock::with_map(self.cfg, map);
        let w = |e: usize, a: u8, b: u8| -> f64 {
            if nozzle.get(usize::from(a - 1)) != nozzle.get(usize::from(b - 1)) {
                return 0.0;
            }
            self.tables
                .get(e)
                .and_then(|t| t.get(usize::from(a - 1)))
                .and_then(|r| r.get(usize::from(b - 1)))
                .copied()
                .unwrap_or(0.0)
        };
        let groups = Groups {
            extruder: ext.to_vec(),
        };
        let mut held = vec![0u8; nozzles];
        let mut last = vec![0u8; self.counts.len()];
        let mut cur = 0u8;
        let (mut flush, mut time) = (0.0, 0.0);
        for (l, here) in self.layers.iter().enumerate() {
            let here: Vec<u8> = here
                .iter()
                .copied()
                .filter(|&s| s >= 1 && s <= self.tools)
                .collect();
            if here.is_empty() {
                continue;
            }
            let next = self.layers.get(l + 1).cloned().unwrap_or_default();
            let order = groups.order(&w, &here, &next, cur, &last);
            for f in order {
                if f == cur {
                    continue;
                }
                let n = usize::from(nozzle.get(usize::from(f - 1)).copied().unwrap_or(0));
                let e = usize::from(ext.get(usize::from(f - 1)).copied().unwrap_or(0));
                if let Some(&h) = held.get(n)
                    && h != 0
                    && h != f
                {
                    flush += self
                        .tables
                        .get(e)
                        .and_then(|t| t.get(usize::from(h - 1)))
                        .and_then(|r| r.get(usize::from(f - 1)))
                        .copied()
                        .unwrap_or(0.0);
                }
                time += clock.change(usize::from(f - 1));
                if let Some(h) = held.get_mut(n) {
                    *h = f;
                }
                if let Some(x) = last.get_mut(e) {
                    *x = f;
                }
                cur = f;
            }
        }
        (flush, time)
    }
}

/// Filaments grouped by extruder for ordering a layer.
#[derive(Debug, Clone)]
pub(crate) struct Groups {
    /// The extruder (0-based) of each slot, index slot - 1.
    pub(crate) extruder: Vec<u8>,
}

impl Groups {
    fn of(&self, slot: u8) -> usize {
        usize::from(
            self.extruder
                .get(usize::from(slot.max(1) - 1))
                .copied()
                .unwrap_or(0),
        )
    }

    /// The order of a layer printing `here` after filament `cur`, each extruder's filaments together
    /// (as Bambu Studio orders a layer under a filament map): the extruder
    /// that printed last goes on first, then the others; inside an extruder the order with the least flush
    /// from the filament it last printed (`last`, per extruder, 0 for none), looking at the next layer as
    /// Orca does. `w(extruder, a, b)` is the flush from `a` to `b` on that extruder.
    pub(crate) fn order(
        &self,
        w: &dyn Fn(usize, u8, u8) -> f64,
        here: &[u8],
        next: &[u8],
        cur: u8,
        last: &[u8],
    ) -> Vec<u8> {
        let count = self
            .extruder
            .iter()
            .map(|&e| usize::from(e) + 1)
            .max()
            .unwrap_or(1)
            .max(last.len());
        let first = if cur == 0 {
            here.first().map_or(0, |&s| self.of(s))
        } else {
            self.of(cur)
        };
        let mut out = Vec::with_capacity(here.len());
        for e in std::iter::once(first).chain((0..count).filter(|&e| e != first)) {
            let mine: Vec<u8> = here.iter().copied().filter(|&s| self.of(s) == e).collect();
            if mine.is_empty() {
                continue;
            }
            let theirs: Vec<u8> = next.iter().copied().filter(|&s| self.of(s) == e).collect();
            let start = last.get(e).copied().filter(|&s| s != 0);
            let we = |a: u8, b: u8| w(e, a, b);
            out.extend(crate::toolorder::cheapest(&we, &mine, &theirs, start));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h2d(extra: &[(&str, serde_json::Value)]) -> PrintConfig {
        let mut c = PrintConfig::builtin();
        for (k, v) in [
            ("printer_model", serde_json::json!("Bambu Lab H2D")),
            ("nozzle_diameter", serde_json::json!([0.4, 0.4])),
            ("master_extruder_id", serde_json::json!(2)),
            ("machine_switch_extruder_time", serde_json::json!(5.6)),
            ("machine_load_filament_time", serde_json::json!(26)),
            ("machine_unload_filament_time", serde_json::json!(26)),
            (
                "flush_volumes_matrix",
                serde_json::json!([0, 306, 618, 0, 0, 321, 633, 0]),
            ),
        ] {
            c.raw.insert(k.into(), v);
        }
        for (k, v) in extra {
            c.raw.insert((*k).into(), v.clone());
        }
        c
    }

    fn every_layer(slots: &[u8], n: usize) -> Usage {
        Usage {
            layers: vec![slots.to_vec(); n],
            boxes: Vec::new(),
        }
    }

    #[test]
    fn two_filaments_on_every_layer_take_one_extruder_each() {
        // Bambu Studio's answer for this plate is "2 1": filament 1 on the right (master) extruder.
        let Some(m) = Map::resolve(&h2d(&[]), 2, &every_layer(&[1, 2], 50)) else {
            panic!("a map")
        };
        assert_eq!(m.extruder, vec![1, 0]);
        assert_eq!(m.nozzle, vec![1, 0]);
        assert!(m.auto);
        let c = m.apply(&h2d(&[]));
        assert_eq!(c.raw.get("filament_map"), Some(&serde_json::json!([2, 1])));
    }

    #[test]
    fn a_manual_map_is_kept() {
        let c = h2d(&[
            ("filament_map_mode", serde_json::json!("Manual")),
            ("filament_map", serde_json::json!([1, 1, 2])),
        ]);
        let Some(m) = Map::resolve(&c, 3, &every_layer(&[1, 2, 3], 10)) else {
            panic!("a map")
        };
        assert_eq!(m.extruder, vec![0, 0, 1]);
        assert!(!m.auto);
    }

    #[test]
    fn the_project_has_as_many_filaments_as_its_longest_filament_list() {
        let mut c = h2d(&[]);
        assert_eq!(project_filaments(&c), 1);
        c.raw.insert(
            "filament_colour".into(),
            serde_json::json!(["#ff0000", "#00ff00", "#0000ff"]),
        );
        c.raw
            .insert("filament_type".into(), serde_json::json!(["PLA", "PLA"]));
        assert_eq!(project_filaments(&c), 3);
    }

    #[test]
    fn a_filament_the_plate_never_prints_with_goes_left() {
        // Bambu Studio maps filament 3, which nothing prints with, to the left extruder: "2 1 1".
        let Some(m) = Map::resolve(&h2d(&[]), 3, &every_layer(&[1, 2], 20)) else {
            panic!("a map")
        };
        assert_eq!(m.extruder, vec![1, 0, 0]);
        // One filament printing: it takes the master extruder, the unused one the left.
        let Some(m) = Map::resolve(&h2d(&[]), 2, &every_layer(&[2], 20)) else {
            panic!("a map")
        };
        assert_eq!(m.extruder, vec![0, 1]);
    }

    #[test]
    fn a_filament_out_of_one_extruders_reach_goes_to_the_other() {
        // H2C: the left nozzle reaches x 0 to 325, the right one 25 to 330. Filament 2 sits at x 10.
        let c = h2d(&[(
            "extruder_printable_area",
            serde_json::json!([
                [[0, 0], [325, 0], [325, 320], [0, 320]],
                [[25, 0], [330, 0], [330, 320], [25, 320]]
            ]),
        )]);
        let u = Usage {
            layers: vec![vec![1, 2]; 20],
            boxes: vec![
                Some([100.0, 100.0, 150.0, 150.0]),
                Some([10.0, 100.0, 60.0, 150.0]),
            ],
        };
        let Some(m) = Map::resolve(&c, 2, &u) else {
            panic!("a map")
        };
        assert_eq!(m.extruder, vec![1, 0]);
        // Filament 1 out of the left nozzle's reach instead: they swap.
        let u = Usage {
            layers: vec![vec![1, 2]; 20],
            boxes: vec![
                Some([300.0, 100.0, 328.0, 150.0]),
                Some([100.0, 100.0, 150.0, 150.0]),
            ],
        };
        let Some(m) = Map::resolve(&c, 2, &u) else {
            panic!("a map")
        };
        assert_eq!(m.extruder, vec![1, 0]);
        let u = Usage {
            layers: vec![vec![1, 2]; 20],
            boxes: vec![
                Some([100.0, 100.0, 150.0, 150.0]),
                Some([300.0, 100.0, 328.0, 150.0]),
            ],
        };
        let Some(m) = Map::resolve(&c, 2, &u) else {
            panic!("a map")
        };
        assert_eq!(m.extruder, vec![0, 1]);
    }

    #[test]
    fn colors_that_never_meet_share_an_extruder() {
        // Filaments 1 and 2 print on separate layer ranges and flush little between them; 3 prints on
        // every layer. Keeping 3 alone on one extruder saves a flush on every layer.
        let mut layers = vec![vec![1, 3]; 30];
        layers.extend(vec![vec![2, 3]; 30]);
        let u = Usage {
            layers,
            boxes: Vec::new(),
        };
        let c = h2d(&[(
            "flush_volumes_matrix",
            serde_json::json!([
                0, 100, 600, 100, 0, 600, 600, 600, 0, 0, 100, 600, 100, 0, 600, 600, 600, 0
            ]),
        )]);
        let Some(m) = Map::resolve(&c, 3, &u) else {
            panic!("a map")
        };
        assert_eq!(m.extruder[0], m.extruder[1]);
        assert_ne!(m.extruder[0], m.extruder[2]);
    }

    #[test]
    fn the_h2c_rack_gives_each_right_filament_a_hotend() {
        let c = h2d(&[
            ("printer_model", serde_json::json!("Bambu Lab H2C")),
            ("extruder_max_nozzle_count", serde_json::json!([1, 6])),
            ("filament_map_mode", serde_json::json!("Manual")),
            ("filament_map", serde_json::json!([2, 2, 1, 2])),
        ]);
        let Some(m) = Map::resolve(&c, 4, &every_layer(&[1, 2, 3, 4], 5)) else {
            panic!("a map")
        };
        assert_eq!(m.extruder, vec![1, 1, 0, 1]);
        assert_eq!(m.nozzle, vec![1, 2, 0, 3]);
    }

    #[test]
    fn printers_without_a_shared_feed_have_no_map() {
        let mut u1 = PrintConfig::builtin();
        u1.raw
            .insert("nozzle_diameter".into(), serde_json::json!([0.4, 0.4, 0.4, 0.4]));
        u1.raw
            .insert("single_extruder_multi_material".into(), serde_json::json!(false));
        assert!(Map::resolve(&u1, 2, &every_layer(&[1, 2], 5)).is_none());
        let p1s = PrintConfig::builtin();
        assert!(Map::resolve(&p1s, 2, &every_layer(&[1, 2], 5)).is_none());
    }

    #[test]
    fn layers_alternate_extruders_without_coming_back() {
        // Filament 1 on the right, 2 on the left: each layer starts on the extruder the last one ended on.
        let g = Groups { extruder: vec![1, 0] };
        let w = |_: usize, _: u8, _: u8| 0.0;
        assert_eq!(g.order(&w, &[1, 2], &[1, 2], 2, &[2, 1]), vec![2, 1]);
        assert_eq!(g.order(&w, &[1, 2], &[1, 2], 1, &[2, 1]), vec![1, 2]);
    }

    /// A box `x0..x1` by `0..20` by `0..z` mm on filament 1.
    fn boxed(x0: f32, x1: f32, z: f32) -> crate::mesh::MeshPart {
        crate::mesh::MeshPart {
            name: "box".to_owned(),
            slot: 1,
            color: None,
            positions: vec![
                [x0, 0.0, 0.0],
                [x1, 0.0, 0.0],
                [x1, 20.0, 0.0],
                [x0, 20.0, 0.0],
                [x0, 0.0, z],
                [x1, 0.0, z],
                [x1, 20.0, z],
                [x0, 20.0, z],
            ],
            triangles: vec![
                [0, 2, 1],
                [0, 3, 2],
                [4, 5, 6],
                [4, 6, 7],
                [0, 1, 5],
                [0, 5, 4],
                [1, 2, 6],
                [1, 6, 5],
                [2, 3, 7],
                [2, 7, 6],
                [3, 0, 4],
                [3, 4, 7],
            ],
            paint: Vec::new(),
            support_paint: Vec::new(),
            seam_paint: Vec::new(),
            fuzzy_paint: Vec::new(),
            paint_texts: Vec::new(),
        }
    }

    /// A 20 mm box on filament 1 at the bed's origin, with a modifier over `x0..x1` carrying `settings`.
    fn box_with_modifier(x0: f32, x1: f32, settings: serde_json::Value) -> crate::plate::Plate {
        let mesh = |part| crate::mesh::Mesh {
            name: "box".to_owned(),
            parts: vec![part],
            ..crate::mesh::Mesh::default()
        };
        let mut plate = crate::plate::Plate::single(mesh(boxed(0.0, 20.0, 20.0)));
        if let Some(o) = plate.objects.first_mut() {
            o.transform = crate::plate::IDENTITY;
            o.volumes.push(crate::plate::PlateVolume {
                name: "modifier".to_owned(),
                role: crate::plate::VolumeRole::Modifier,
                mesh: std::sync::Arc::new(mesh(boxed(x0, x1, 20.0))),
                transform: None,
                settings,
            });
        }
        plate
    }

    fn range(
        from: f64,
        to: f64,
        settings: serde_json::Value,
        objects: &[&str],
    ) -> crate::session::HeightRange {
        crate::session::HeightRange {
            z_from_mm: from,
            z_to_mm: to,
            settings,
            objects: objects.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    /// The layers (by index) that print with `slot`.
    fn layers_of(u: &Usage, slot: u8) -> Vec<usize> {
        u.layers
            .iter()
            .enumerate()
            .filter(|(_, l)| l.contains(&slot))
            .map(|(i, _)| i)
            .collect()
    }

    #[test]
    fn a_modifier_s_wall_filament_counts_over_the_area_it_reaches() {
        let walls = serde_json::json!({"outer_wall_filament_id": 3, "inner_wall_filament_id": 3});
        let u = Usage::of_plate(&box_with_modifier(10.0, 20.0, walls.clone()), &h2d(&[]), &[]);
        assert_eq!(
            layers_of(&u, 3).len(),
            u.layers.len(),
            "every layer has walls on 3"
        );
        assert_eq!(
            layers_of(&u, 1).len(),
            u.layers.len(),
            "the rest of the box stays on 1"
        );
        assert_eq!(u.boxes.get(2).copied().flatten(), Some([10.0, 0.0, 20.0, 20.0]));
        // A modifier off to the side of the box changes nothing that prints.
        let u = Usage::of_plate(&box_with_modifier(30.0, 40.0, walls), &h2d(&[]), &[]);
        assert!(layers_of(&u, 3).is_empty());
        // Nor does one without filaments of its own.
        let loops = serde_json::json!({"wall_loops": 4});
        let u = Usage::of_plate(&box_with_modifier(10.0, 20.0, loops), &h2d(&[]), &[]);
        assert!(layers_of(&u, 3).is_empty());
    }

    #[test]
    fn a_height_range_s_filaments_count_on_its_heights() {
        let plate = box_with_modifier(30.0, 40.0, serde_json::Value::Null);
        let cfg = h2d(&[]);
        let sparse = serde_json::json!({"sparse_infill_filament_id": 3});
        let u = Usage::of_plate(&plate, &cfg, &[range(8.0, 14.0, sparse.clone(), &[])]);
        let on3 = layers_of(&u, 3);
        assert!(!on3.is_empty());
        let first = cfg.initial_layer_print_height;
        let step = cfg.layer_height;
        #[allow(clippy::cast_precision_loss, reason = "a layer index")]
        let span = |l: usize| (first + (l as f64 - 1.0) * step, first + l as f64 * step);
        for &l in &on3 {
            let (z0, z1) = span(l);
            assert!(z1 > 8.0 - 1e-9 && z0 < 14.0 + 1e-9, "layer {l} at {z0}..{z1}");
        }
        // A range for another object leaves this one alone, and a later range wins where they overlap.
        let u = Usage::of_plate(&plate, &cfg, &[range(8.0, 14.0, sparse.clone(), &["other"])]);
        assert!(layers_of(&u, 3).is_empty());
        let back = serde_json::json!({"sparse_infill_filament_id": 0});
        let u = Usage::of_plate(
            &plate,
            &cfg,
            &[
                range(8.0, 14.0, sparse, &["object-1"]),
                range(0.0, 20.0, back, &[]),
            ],
        );
        assert!(layers_of(&u, 3).is_empty());
    }

    #[test]
    fn a_range_leaves_a_part_with_its_own_settings_alone() {
        let walls = serde_json::json!({"outer_wall_filament_id": 3, "inner_wall_filament_id": 3});
        let all = [range(0.0, 20.0, walls.clone(), &[])];
        let mut plate = box_with_modifier(30.0, 40.0, serde_json::Value::Null);
        if let Some(o) = plate.objects.first_mut() {
            o.part_settings = vec![("box".to_owned(), serde_json::json!({"wall_loops": 3}))];
        }
        let u = Usage::of_plate(&plate, &h2d(&[]), &all);
        assert!(
            layers_of(&u, 3).is_empty(),
            "a part with its own settings prints like a modifier"
        );
        if let Some(o) = plate.objects.first_mut() {
            o.part_settings = vec![("box".to_owned(), walls)];
        }
        let u = Usage::of_plate(&plate, &h2d(&[]), &[]);
        assert_eq!(
            layers_of(&u, 3).len(),
            u.layers.len(),
            "a part's own wall filament counts"
        );
    }

    #[test]
    fn a_project_s_own_feature_filaments_count_for_nothing() {
        // Read as a plate's settings, the three older names print on nothing, so filament 3 stays out.
        let mut given = serde_json::Map::new();
        for (k, v) in h2d(&[]).raw {
            given.insert(k, v);
        }
        given.insert("wall_filament".into(), serde_json::json!("3"));
        given.insert("sparse_infill_filament".into(), serde_json::json!("3"));
        let Ok(cfg) = PrintConfig::from_value(&serde_json::Value::Object(given)) else {
            panic!("a config")
        };
        let u = Usage::of_plate(&box_with_modifier(30.0, 40.0, serde_json::Value::Null), &cfg, &[]);
        assert!(layers_of(&u, 3).is_empty());
    }
}
