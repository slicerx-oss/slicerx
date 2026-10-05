// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The prime tower: a column beside the print where the nozzle purges the old filament after
//! every tool change, so the next color starts clean on the part.
//!
//! The first layer gets a wall loop, and every tool change on any layer adds a
//! zigzag of rows that extrudes the purge volume (`flush_volumes_matrix` times
//! `flush_multiplier` when the profile has them, else `prime_volume`). The tower is as deep as
//! the largest purge needs and as wide as `prime_tower_width`, at `wipe_tower_x` and
//! `wipe_tower_y` (its front left corner).

use crate::config::PrintConfig;
use crate::fm::Fm as _;
use crate::geom::Point;

/// One extrusion on the tower.
#[derive(Debug, Clone)]
pub(crate) struct TowerPath {
    pub(crate) points: Vec<Point>,
    pub(crate) width_mm: f32,
    /// Print speed, mm/s.
    pub(crate) speed_mm_s: f32,
    /// Flow against a bead of this width at the layer's height.
    pub(crate) flow: f32,
}

/// The tower's geometry for a plate.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Tower {
    x: f64,
    y: f64,
    width: f64,
    depth: f64,
    /// Wall loop bead width and the wider bead the purge rows use, mm.
    wall_w: f64,
    wipe_w: f64,
    /// Distance between purge rows at full density, mm.
    spacing: f64,
    /// Rotation about the front left corner, degrees (`wipe_tower_rotation_angle`).
    angle: f64,
    /// Brim around the first layer, mm (`prime_tower_brim_width`; negative sizes it by the
    /// tower's height).
    brim: f64,
    /// Speeds, mm/s: the first layer, the walls and the purge rows above it.
    first_speed: f64,
    wall_speed: f64,
    purge_speed: f64,
    /// Orca's type 1 (Bambu Lab) tower.
    type1: bool,
    /// The purge prints whole rows (type 1, and `PrusaSlicer`'s wipe, which fills the rows it planned).
    whole_rows: bool,
    /// Orca's rib wall, once the tower's height is known ([`Tower::ribbed`]).
    rib: Option<Rib>,
}

/// Orca's rib wall (`wipe_tower_wall_type` rib on a type 1 tower, `WipeTower::generate_rib_polygon`): the box
/// with a rib along each diagonal, `width` wide and `len` long at the bottom, shrinking to the diagonal at the
/// top, its corners rounded when `fillet`; the tower moves by `offset` so the first layer's wall starts at its
/// corner (`m_rib_offset`).
#[derive(Debug, Clone, Copy)]
struct Rib {
    len: f64,
    width: f64,
    fillet: bool,
    height: f64,
    offset: (f64, f64),
}

/// Orca's purge rows extrude about a tenth more than the volume asked for (measured on two
/// filaments at the default `prime_volume`).
const PURGE_EXTRA: f64 = 1.1;

/// Filament to purge going from slot `from` to slot `to` (1-based), mm3.
pub(crate) fn purge_volume(cfg: &PrintConfig, tools: u8, from: u8, to: u8) -> f64 {
    // Only the prime volume goes on the tower when the flush has somewhere else to go (`Print::
    // _make_wipe_tower`): Bambu Lab printers (Orca's type 1 tower) flush into the chute from the
    // change G-code, and a type 2 tower takes the whole flush only with `purge_in_prime_tower` on a
    // single extruder multi material printer.
    if !flush_on_tower(cfg) {
        // Orca's type 1 rows extrude the prime volume itself; type 2 runs about a tenth over.
        let extra = if type1(cfg) { 1.0 } else { PURGE_EXTRA };
        return cfg.raw_number("prime_volume", 45.0) * extra;
    }
    let mult = cfg.raw_number("flush_multiplier", 1.0).max(0.0);
    let asked = match flush_entry(
        cfg,
        tools,
        usize::from(from.max(1) - 1),
        usize::from(to.max(1) - 1),
    ) {
        Some(v) if v > 0.0 => v * mult,
        _ => cfg.raw_number("prime_volume", 45.0),
    };
    asked * PURGE_EXTRA
}

/// What one tool change puts on the tower, mm3: the new filament's purge rows (`wipe`) and, printed with
/// the old filament before the change, what is rammed out of a nozzle or tool about to be parked (`ram`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ChangePurge {
    pub(crate) wipe: f64,
    pub(crate) ram: f64,
    /// The old filament's rows are Bambu Studio's nozzle change rows (wider, full rows) rather than a
    /// tool changer's ramming.
    pub(crate) nozzle_change: bool,
}

/// The tower's share of a change from slot `from` to slot `to` (1-based):
///
/// - Two extruders with a filament map (H2D, H2C; Bambu Studio's `Print::_make_wipe_tower` and
///   `WipeTower::plan_toolchange`): the new filament primes `filament_prime_volume`, or
///   `filament_prime_volume_nc` after a hotend swap on the rack, and when the nozzle changes the old one
///   first rams out `filament_change_length` (`filament_change_length_nc` for a hotend swap) mm of filament.
///   The flush itself goes to the chute, and only when the nozzle held another filament.
/// - A Prusa tool changer (the XL; `PrusaSlicer`'s `WipeTower::extract_wipe_volumes`): each head that
///   already holds its filament wipes `filament_minimal_purge_on_wipe_tower`, after the old head rams
///   `filament_multitool_ramming_volume` when `filament_multitool_ramming` is on.
/// - Any other tool changer (the Snapmaker U1; Orca's `WipeTower2`): `prime_volume`, plus the multitool
///   ramming when the filament asks for it.
/// - One nozzle: [`purge_volume`].
pub(crate) fn change_purge(cfg: &PrintConfig, tools: u8, from: u8, to: u8) -> ChangePurge {
    let area = std::f64::consts::PI * (cfg.filament_diameter / 2.0).m_powi(2);
    if crate::nozzles::shared(cfg) {
        let slot_of = |key: &str, s: u8, fallback: f64| per_slot_raw(cfg, key, s, fallback).round();
        let (ef, et) = (
            slot_of("filament_map", from, 1.0),
            slot_of("filament_map", to, 1.0),
        );
        let (nf, nt) = (
            slot_of("filament_nozzle_map", from, ef - 1.0),
            slot_of("filament_nozzle_map", to, et - 1.0),
        );
        let nozzle_change = (ef - et).abs() < 0.5 && (nf - nt).abs() > 0.5;
        let prime = cfg.raw_number("prime_volume", 45.0);
        let saving = cfg.raw.get("prime_volume_mode").and_then(|v| v.as_str()) == Some("Saving");
        let wipe = if saving {
            15.0
        } else {
            per_slot_raw(
                cfg,
                if nozzle_change {
                    "filament_prime_volume_nc"
                } else {
                    "filament_prime_volume"
                },
                to,
                prime,
            )
        };
        let ram = if (nf - nt).abs() > 0.5 {
            per_slot_raw(
                cfg,
                if nozzle_change {
                    "filament_change_length_nc"
                } else {
                    "filament_change_length"
                },
                from,
                0.0,
            ) * area
        } else {
            0.0
        };
        return ChangePurge {
            wipe,
            ram,
            nozzle_change: true,
        };
    }
    let ram = if !type1(cfg)
        && !flag_or(cfg, "single_extruder_multi_material", true)
        && slot_flag(cfg, "filament_multitool_ramming", from)
    {
        per_slot_raw(cfg, "filament_multitool_ramming_volume", from, 10.0).max(0.0)
    } else {
        0.0
    };
    if prusa_tools(cfg) {
        let wipe = per_slot_raw(cfg, "filament_minimal_purge_on_wipe_tower", to, 15.0).max(0.0);
        return ChangePurge {
            wipe,
            ram,
            nozzle_change: false,
        };
    }
    ChangePurge {
        wipe: purge_volume(cfg, tools, from, to),
        ram,
        nozzle_change: false,
    }
}

/// A tool changer's type 2 tower, where each layer's first purge gives way to what finishing the layer
/// extrudes anyway (Orca's and `PrusaSlicer`'s `save_on_last_wipe`). A single nozzle keeps its purge.
pub(crate) fn saves_on_last_wipe(cfg: &PrintConfig) -> bool {
    !type1(cfg) && !flag_or(cfg, "single_extruder_multi_material", true)
}

/// A Prusa printer with several tool heads (the XL): its maker's slicer purges by
/// `filament_minimal_purge_on_wipe_tower`, not by the flush matrix or `prime_volume`.
pub(crate) fn prusa_tools(cfg: &PrintConfig) -> bool {
    let model = cfg
        .raw
        .get("printer_model")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    !type1(cfg)
        && crate::nozzles::extruders(cfg) > 1
        && !flag_or(cfg, "single_extruder_multi_material", true)
        && (model.starts_with("Prusa") || model.starts_with("Original Prusa"))
}

/// A per-filament switch (a list by slot, or one value).
pub(crate) fn slot_flag(cfg: &PrintConfig, key: &str, slot: u8) -> bool {
    let truthy = |v: &serde_json::Value| match v {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        serde_json::Value::String(s) => s == "1" || s == "true",
        _ => false,
    };
    match cfg.raw.get(key) {
        Some(serde_json::Value::Array(a)) => a
            .get(usize::from(slot.max(1) - 1))
            .or_else(|| a.last())
            .is_some_and(truthy),
        Some(v) => truthy(v),
        None => false,
    }
}

/// True on a printer Orca builds a type 1 (Bambu Lab) tower for (`Print::wipe_tower_type`: every
/// Bambu Lab printer, else the `wipe_tower_type` setting).
pub(crate) fn type1(cfg: &PrintConfig) -> bool {
    let model = cfg
        .raw
        .get("printer_model")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    cfg.gcode_flavor == crate::config::GcodeFlavor::Bambu
        || model.starts_with("Bambu Lab")
        || cfg.raw.get("wipe_tower_type").and_then(|v| v.as_str()) == Some("type1")
}

/// True when a type 1 tower is sized square instead of `prime_tower_width` wide: Orca's rib wall
/// (`wipe_tower_wall_type` rib, its default), which we build as a plain outline round a square of
/// purge rows (`PartPlate::estimate_wipe_tower_size`: the rib tower is as wide as it is deep).
pub(crate) fn square(cfg: &PrintConfig) -> bool {
    type1(cfg)
        && cfg
            .raw
            .get("wipe_tower_wall_type")
            .and_then(|v| v.as_str())
            .unwrap_or("rib")
            == "rib"
}

/// The least footprint side a tower this tall stands on (`WipeTower::min_depth_per_height`,
/// interpolated: 5 mm up to 5 mm tall, 20 at 100, 40 at 250, 60 at 350 and above).
pub(crate) fn min_side_by_height(height: f64) -> f64 {
    let table = [(5.0, 5.0), (100.0, 20.0), (250.0, 40.0), (350.0, 60.0)];
    let mut prev = (5.0, 5.0);
    for (h, d) in table {
        if height <= h {
            return if h > prev.0 {
                prev.1 + (height - prev.0).max(0.0) / (h - prev.0) * (d - prev.1)
            } else {
                d
            };
        }
        prev = (h, d);
    }
    60.0
}

/// True when the tower takes the whole flush rather than only the prime volume.
pub(crate) fn flush_on_tower(cfg: &PrintConfig) -> bool {
    !type1(cfg)
        && flag_or(cfg, "purge_in_prime_tower", true)
        && flag_or(cfg, "single_extruder_multi_material", true)
}

/// Filament one change from slot `from` to slot `to` (1-based) wastes, mm3: the tower's purge, plus
/// on a type 1 tower the flush into the chute (the matrix volume times the multiplier, at least
/// 100 mm3 when there is any).
pub(crate) fn change_waste(cfg: &PrintConfig, tools: u8, from: u8, to: u8) -> f64 {
    let tower = purge_volume(cfg, tools, from, to);
    if !type1(cfg) {
        return tower;
    }
    let chute = flush_entry(
        cfg,
        tools,
        usize::from(from.max(1) - 1),
        usize::from(to.max(1) - 1),
    )
    .unwrap_or(0.0)
        * cfg.raw_number("flush_multiplier", 1.0);
    tower + if chute > 1e-4 { chute.max(100.0) } else { 0.0 }
}

/// The flush volume from filament `from` to filament `to` (0-based), mm3, before the multiplier;
/// `None` when the settings carry no matrix for them. A printer with several nozzles lists one
/// n by n block per nozzle, one after the other, and the change reads the block of the nozzle the
/// new filament prints with (Orca's `get_flush_volumes_matrix` with the new filament's extruder from
/// `filament_map`).
pub(crate) fn flush_entry(cfg: &PrintConfig, tools: u8, from: usize, to: usize) -> Option<f64> {
    let nozzles = crate::nozzles::extruders(cfg);
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "extruder numbers are small"
    )]
    let nozzle = if nozzles > 1 {
        let map = per_slot_raw(cfg, "filament_map", u8::try_from(to + 1).unwrap_or(u8::MAX), 1.0);
        (map.round().max(1.0) as usize - 1).min(nozzles - 1)
    } else {
        0
    };
    flush_block(cfg, tools, nozzle, from, to)
}

/// The flush volume from filament `from` to filament `to` (0-based) in the matrix block of extruder
/// `block`, mm3, before the multiplier.
pub(crate) fn flush_block(cfg: &PrintConfig, tools: u8, block: usize, from: usize, to: usize) -> Option<f64> {
    let num = |v: &serde_json::Value| match v {
        serde_json::Value::Number(x) => x.as_f64().unwrap_or(0.0),
        serde_json::Value::String(t) => t.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    };
    let matrix: Vec<f64> = match cfg.raw.get("flush_volumes_matrix") {
        Some(serde_json::Value::Array(a)) => a.iter().map(num).collect(),
        Some(serde_json::Value::String(s)) => s.split(',').filter_map(|t| t.trim().parse().ok()).collect(),
        _ => Vec::new(),
    };
    let nozzles = match cfg.raw.get("nozzle_diameter") {
        Some(serde_json::Value::Array(a)) => a.len().max(1),
        _ => 1,
    };
    let mut size = matrix.len() / nozzles;
    // The filament count is the side of a block; a block that is not square falls back to the slots
    // (a matrix with more blocks than extruders, one per nozzle variant, is read in blocks of the slots).
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "a small matrix side"
    )]
    let side = ((size as f64).sqrt().round() as usize).max(1);
    let n = if side * side == size {
        side
    } else {
        let t = usize::from(tools.max(1));
        if matrix.len().is_multiple_of(t * t) {
            size = t * t;
        }
        t
    };
    let nozzle = block.min(nozzles - 1);
    if from >= n || to >= n || size < n * n {
        return None;
    }
    matrix.get(nozzle * size + from * n + to).copied()
}

/// Why the tower stands where it does (the slice report's `primeTower.reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TowerReason {
    /// Where `wipe_tower_x` and `wipe_tower_y` put it.
    Kept,
    /// Picked by the engine (`prime_tower_auto_position`, on by default).
    Auto,
    /// Pulled back onto the bed by the least distance.
    MovedOntoBed,
    /// Moved to the nearest spot clear of the objects and the printer's no-go zones.
    MovedClear,
    /// Made wider and shallower, or turned a quarter, to fit at all.
    Reshaped,
}

/// The tower's footprint as placed: front left corner, width, rotation and depth in purge rows.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Placement {
    pub(crate) origin: [f64; 2],
    pub(crate) width: f64,
    pub(crate) angle: f64,
    pub(crate) rows: f64,
    pub(crate) reason: TowerReason,
}

impl Placement {
    /// The tower for this placement.
    pub(crate) fn tower(&self, cfg: &PrintConfig, tools: u8) -> Option<Tower> {
        Tower::new(cfg, tools, self.rows).map(|t| t.shaped(self.width, self.angle).at(self.origin))
    }

    /// The report entry: corner, size and reason, mm.
    pub(crate) fn report(&self, cfg: &PrintConfig, tools: u8) -> Option<crate::output::TowerPlacement> {
        let t = self.tower(cfg, tools)?;
        Some(crate::output::TowerPlacement {
            x: self.origin[0],
            y: self.origin[1],
            width: t.width,
            depth: t.depth,
            angle: t.angle,
            reason: self.reason,
        })
    }
}

/// Boxes `[min x, min y, max x, max y]` the tower must stay out of besides the objects: every
/// `bed_exclude_area` zone (Bambu's cutter and purge corner among them) and the purge line the
/// start G-code draws on the bed (its extruding moves below 1 mm, as literal coordinates).
fn no_go(cfg: &PrintConfig) -> Vec<[f64; 4]> {
    let bbox = |pts: &[[f64; 2]]| {
        pts.iter().fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| {
            [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
        })
    };
    let mut out: Vec<[f64; 4]> = crate::preflight::exclude_zones(cfg)
        .iter()
        .map(|z| bbox(z))
        .collect();
    let start = cfg
        .raw
        .get("machine_start_gcode")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let (mut x, mut y, mut z) = (None::<f64>, None::<f64>, None::<f64>);
    let mut line_pts: Vec<[f64; 2]> = Vec::new();
    for raw in start.lines() {
        let code = raw.split(';').next().unwrap_or("");
        let mut words = code.split_ascii_whitespace();
        let Some(cmd) = words.next() else { continue };
        if !matches!(cmd, "G0" | "G1") {
            if cmd == "G28" {
                (x, y, z) = (None, None, None);
            }
            continue;
        }
        let (mut nx, mut ny, mut e) = (x, y, None::<f64>);
        for w in words {
            let (k, v) = w.split_at(w.len().min(1));
            let val = v.parse::<f64>().ok();
            match k {
                "X" => nx = val,
                "Y" => ny = val,
                "Z" => z = val,
                "E" => e = val,
                _ => {}
            }
        }
        if e.is_some_and(|e| e > 0.0)
            && z.is_some_and(|z| z < 1.0)
            && let (Some(ax), Some(ay), Some(bx), Some(by)) = (x, y, nx, ny)
        {
            line_pts.extend([[ax, ay], [bx, by]]);
        }
        (x, y) = (nx, ny);
    }
    if !line_pts.is_empty() {
        let b = bbox(&line_pts);
        out.push([b[0] - 2.0, b[1] - 2.0, b[2] + 2.0, b[3] + 2.0]);
    }
    out
}

/// Where the tower stands and how big it is. `rows_at` gives the purge rows the tower needs at a
/// width. With `prime_tower_auto_position` off the tower stays at `wipe_tower_x` and `wipe_tower_y` when that is on
/// the bed and clear; else it is pulled back onto the bed by the least distance, the way Orca's plate
/// places it (`PartPlateList::set_default_wipe_tower_pos_for_plate`, margin `WIPE_TOWER_MARGIN` plus
/// the brim); else it takes the nearest clear spot on a 1 mm grid. By default (the setting on)
/// the engine picks the clear spot nearest the objects (shortest travel), preferring the back of the
/// bed. Where nothing fits, the tower gets wider (same purge, fewer rows) and is turned a quarter.
/// Clear means on the bed with a 1 mm margin, the tower's brim included, outside the printer's
/// no-go zones, and the object brim plus 1 mm from every object. `None` when the tower is off or
/// not needed, an error when it fits nowhere. Every step is plain arithmetic in a fixed order, so
/// native and WASM pick the same spot.
pub(crate) fn place(
    cfg: &PrintConfig,
    tools: u8,
    rows_at: &dyn Fn(f64) -> f64,
    rib: Option<(f64, f64)>,
    objects: &[crate::output::ObjectFootprint],
    height: f64,
) -> crate::error::Result<Option<Placement>> {
    let Some(t0) = Tower::new(cfg, tools, 1.0) else {
        return Ok(None);
    };
    // Orca's rib tower has its own size (`rib_size`); the rows are what fills its depth.
    let rib = rib
        .filter(|&(w, d)| w > 0.0 && d > 0.0)
        .map(|(w, d)| (w, ((d - 2.0 * t0.wall_w) / t0.spacing).max(1.0)));
    let rows_at = |w: f64| match rib {
        Some((rw, rows)) if (w - rw).abs() < 1e-9 => rows,
        _ => rows_at(w),
    };
    let width0 = if let Some((w, _)) = rib {
        w
    } else if square(cfg) {
        // The narrowest square: as wide as the purges make it deep, and no narrower than its
        // height needs to stand.
        let mut w = min_side_by_height(height).max(5.0);
        while w < 300.0 && Tower::new(cfg, tools, rows_at(w)).is_some_and(|t| t.depth > w) {
            w += 0.5;
        }
        w
    } else {
        cfg.raw_number("prime_tower_width", 35.0).max(5.0)
    };
    let auto = flag_or(cfg, "prime_tower_auto_position", true);
    let bed = cfg.bed_rect();
    let pad = cfg.brim_width.max(0.0) + 1.0;
    let hull_box = |o: &crate::output::ObjectFootprint| {
        o.hull
            .iter()
            .fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| {
                [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
            })
    };
    let mut boxes: Vec<[f64; 4]> = objects
        .iter()
        .map(hull_box)
        .map(|b| [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad])
        .collect();
    boxes.extend(no_go(cfg));
    // The objects' middle, for the travel score.
    let mid = if objects.is_empty() {
        [f64::midpoint(bed[0], bed[2]), f64::midpoint(bed[1], bed[3])]
    } else {
        let all = objects
            .iter()
            .map(hull_box)
            .fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, h| {
                [b[0].min(h[0]), b[1].min(h[1]), b[2].max(h[2]), b[3].max(h[3])]
            });
        [f64::midpoint(all[0], all[2]), f64::midpoint(all[1], all[3])]
    };
    // Shapes to try: as configured, then wider in 10 mm steps up to the bed, each also turned a quarter.
    let mut widths = vec![width0];
    let mut w = width0 + 10.0;
    while w <= bed[2] - bed[0] - 2.0 {
        widths.push(w);
        w += 10.0;
    }
    for (k, &width) in widths.iter().enumerate() {
        let rows = rows_at(width);
        for turn in [0.0, 90.0] {
            let Some(t) = Tower::new(cfg, tools, rows).map(|t| {
                t.shaped(width, t0.angle + turn)
                    .ribbed(cfg, height, cfg.initial_layer_print_height)
            }) else {
                continue;
            };
            let r = t.reach(t.brim.max(0.0));
            let clear = |x: f64, y: f64| {
                let (lx, ly, hx, hy) = (x + r[0], y + r[1], x + r[2], y + r[3]);
                lx >= bed[0] + 1.0
                    && ly >= bed[1] + 1.0
                    && hx <= bed[2] - 1.0
                    && hy <= bed[3] - 1.0
                    && boxes
                        .iter()
                        .all(|b| hx <= b[0] || lx >= b[2] || hy <= b[1] || ly >= b[3])
            };
            let reshaped = k > 0 || turn != 0.0;
            let done = |origin: [f64; 2], reason: TowerReason| {
                Ok(Some(Placement {
                    origin,
                    width,
                    angle: t.angle,
                    rows,
                    reason: if reshaped { TowerReason::Reshaped } else { reason },
                }))
            };
            if !auto {
                if clear(t0.x, t0.y) {
                    return done([t0.x, t0.y], TowerReason::Kept);
                }
                let inside = |v: f64, lo: f64, hi: f64| if hi < lo { v } else { v.clamp(lo, hi) };
                let (cx, cy) = (
                    inside(t0.x, bed[0] + 1.0 - r[0], bed[2] - 1.0 - r[2]),
                    inside(t0.y, bed[1] + 1.0 - r[1], bed[3] - 1.0 - r[3]),
                );
                if clear(cx, cy) {
                    return done([cx, cy], TowerReason::MovedOntoBed);
                }
            }
            // Every clear spot on a 1 mm grid from the bed's front left; the best score wins, the first
            // found on a tie.
            let score = |x: f64, y: f64| {
                if auto {
                    let c = [x + f64::midpoint(r[0], r[2]), y + f64::midpoint(r[1], r[3])];
                    (c[0] - mid[0]).m_hypot(c[1] - mid[1]) + 0.25 * (bed[3] - (y + r[3]))
                } else {
                    (x - t0.x).m_hypot(y - t0.y)
                }
            };
            let mut best: Option<(f64, [f64; 2])> = None;
            let x0 = (bed[0] + 1.0 - r[0]).ceil();
            let y0 = (bed[1] + 1.0 - r[1]).ceil();
            let mut y = y0;
            while y + r[3] <= bed[3] - 1.0 {
                let mut x = x0;
                while x + r[2] <= bed[2] - 1.0 {
                    if clear(x, y) {
                        let s = score(x, y);
                        if best.is_none_or(|(b, _)| s < b - 1e-9) {
                            best = Some((s, [x, y]));
                        }
                    }
                    x += 1.0;
                }
                y += 1.0;
            }
            if let Some((_, p)) = best {
                return done(
                    p,
                    if auto {
                        TowerReason::Auto
                    } else {
                        TowerReason::MovedClear
                    },
                );
            }
        }
    }
    Err(crate::error::Error::Blocked(format!(
        "the prime tower ({width0:.0} x {:.0} mm) does not fit on the bed clear of the objects, even made wider or turned",
        Tower::new(cfg, tools, rows_at(width0)).map_or(0.0, |t| t.depth)
    )))
}

impl Tower {
    /// Width, mm.
    pub(crate) fn width(&self) -> f64 {
        self.width
    }

    /// Rotation about the front left corner, degrees.
    pub(crate) fn angle(&self) -> f64 {
        self.angle
    }

    /// The front left corner, mm.
    pub(crate) fn origin(&self) -> [f64; 2] {
        [self.x, self.y]
    }

    /// The same tower with another width and rotation (its depth stays the rows it was made for).
    pub(crate) fn shaped(mut self, width: f64, angle: f64) -> Self {
        self.width = width.max(5.0);
        self.angle = angle;
        self
    }

    /// The same tower at another corner.
    pub(crate) fn at(mut self, origin: [f64; 2]) -> Self {
        self.x = origin[0];
        self.y = origin[1];
        self
    }

    /// The tower for a plate with `tools` filaments, or none when it is off or the plate uses one.
    pub(crate) fn new(cfg: &PrintConfig, tools: u8, rows: f64) -> Option<Self> {
        let on = match cfg.raw.get("enable_prime_tower") {
            Some(serde_json::Value::Bool(b)) => *b,
            Some(serde_json::Value::Number(n)) => n.as_f64().is_some_and(|v| v != 0.0),
            Some(serde_json::Value::String(s)) => s == "1" || s == "true",
            _ => false,
        };
        if !on || tools < 2 {
            return None;
        }
        let nozzle = cfg.nozzle_diameter;
        let wall_w = nozzle * 1.25;
        // WipeTower2: the purge rows are `wipe_tower_extra_flow` wider and that much further apart,
        // times `wipe_tower_extra_spacing`.
        let extra_flow = (cfg.raw_number("wipe_tower_extra_flow", 100.0) / 100.0).clamp(0.5, 3.0);
        let extra_spacing = (cfg.raw_number("wipe_tower_extra_spacing", 100.0) / 100.0).clamp(0.5, 5.0);
        // Type 1 (Bambu Lab) rows are wall-width beads `prime_tower_infill_gap` apart (`WipeTower`
        // `m_extra_spacing`); type 2 rows are wider beads (`WipeTower2`).
        let (wipe_w, spacing) = if type1(cfg) {
            (
                wall_w,
                wall_w
                    * cfg
                        .raw_number("prime_tower_infill_gap", 150.0)
                        .clamp(100.0, 300.0)
                    / 100.0,
            )
        } else {
            (wall_w * 1.15 * extra_flow, wall_w * extra_flow * extra_spacing)
        };
        let width = cfg.raw_number("prime_tower_width", 35.0).max(5.0);
        let rows = rows.max(1.0);
        let max_purge = cfg.raw_number("wipe_tower_max_purge_speed", 90.0).max(1.0);
        let first_speed = if cfg.initial_layer_speed > 0.0 {
            cfg.initial_layer_speed
        } else {
            30.0
        };
        let positive = |v: f64| if v > 0.0 { v } else { 80.0 };
        Some(Self {
            x: cfg.raw_number("wipe_tower_x", 15.0),
            y: cfg.raw_number("wipe_tower_y", 220.0),
            width,
            depth: rows * spacing + 2.0 * wall_w,
            wall_w,
            wipe_w,
            spacing,
            angle: cfg.raw_number("wipe_tower_rotation_angle", 0.0),
            brim: cfg.raw_number("prime_tower_brim_width", 3.0),
            first_speed,
            wall_speed: max_purge.min(positive(cfg.inner_wall_speed)),
            // PrusaSlicer wipes at the infill speed with no cap of its own (`WipeTower::toolchange_Wipe`).
            purge_speed: if prusa_tools(cfg) {
                positive(cfg.sparse_infill_speed)
            } else {
                max_purge.min(positive(cfg.sparse_infill_speed))
            },
            type1: type1(cfg),
            whole_rows: type1(cfg) || prusa_tools(cfg),
            rib: None,
        })
    }

    /// The tower with Orca's rib wall when the profile asks for it (`WipeTower::plan_tower_new`): `height` is
    /// the tower's top, `first_z` its first layer's.
    pub(crate) fn ribbed(mut self, cfg: &PrintConfig, height: f64, first_z: f64) -> Self {
        if !square(cfg) || height <= 0.0 {
            return self;
        }
        let (a, b) = (self.width, self.depth);
        let diag = a.m_hypot(b);
        // a tower shallower than its height needs stands on longer ribs (`get_limit_depth_by_height`)
        let mut len = if b - self.wall_w + 1e-4 < limit_depth_by_height(height) {
            limit_depth_by_height(height) * std::f64::consts::SQRT_2
        } else {
            0.0
        };
        len = len.max(diag) + cfg.raw_number("wipe_tower_extra_rib_length", 0.0);
        let width = cfg.raw_number("wipe_tower_rib_width", 8.0).min(a.min(b) / 2.0);
        self.rib = Some(Rib {
            len: len.max(diag),
            width,
            fillet: flag_or(cfg, "wipe_tower_fillet_wall", true),
            height,
            offset: (0.0, 0.0),
        });
        let first = self.wall_polygon(first_z);
        let (lx, ly) = first
            .iter()
            .fold((f64::MAX, f64::MAX), |m, p| (m.0.min(p.0), m.1.min(p.1)));
        if let Some(r) = self.rib.as_mut() {
            r.offset = (-lx, -ly);
        }
        self
    }

    /// The wall's centerline at height `z` in the tower's frame: the box, or Orca's rib wall round it.
    fn wall_polygon(&self, z: f64) -> Vec<(f64, f64)> {
        let (a, b) = (self.width, self.depth);
        let boxed = vec![(0.0, 0.0), (a, 0.0), (a, b), (0.0, b)];
        let Some(r) = self.rib else {
            return boxed;
        };
        let diag = a.m_hypot(b);
        let extra = ((r.len - diag) / 2.0).max(0.0) * ((r.height - z).abs() / r.height);
        let rib = |p1: (f64, f64), p2: (f64, f64)| {
            let (ux, uy) = ((p2.0 - p1.0) / diag, (p2.1 - p1.1) / diag);
            let (p1, p2) = (
                (p1.0 - ux * extra, p1.1 - uy * extra),
                (p2.0 + ux * extra, p2.1 + uy * extra),
            );
            let (ox, oy) = (-uy * r.width / 2.0, ux * r.width / 2.0);
            vec![
                (p1.0 + ox, p1.1 + oy),
                (p1.0 - ox, p1.1 - oy),
                (p2.0 - ox, p2.1 - oy),
                (p2.0 + ox, p2.1 + oy),
            ]
        };
        let union = |polys: &[Vec<(f64, f64)>]| -> Vec<(f64, f64)> {
            let shapes: Vec<crate::perimeters::Shapes> =
                polys.iter().map(|p| vec![vec![ring_int(p)]]).collect();
            let refs: Vec<&crate::perimeters::Shapes> = shapes.iter().collect();
            crate::perimeters::union_all(&refs)
                .first()
                .and_then(|s| s.first())
                .map(|ring| ring.iter().map(|q| (from_int(q.x), from_int(q.y))).collect())
                .unwrap_or_default()
        };
        let mut wall = union(&[boxed.clone(), rib((0.0, 0.0), (a, b)), rib((a, 0.0), (0.0, b))]);
        if r.fillet {
            wall = union(&[rounded(&wall, 2.0), boxed]);
        }
        wall
    }

    /// The wall loop at height `z`, closed: inside the tower's edge, or Orca's rib wall on its edge.
    pub(crate) fn wall(&self, first: bool, z: f64) -> TowerPath {
        let h = self.wall_w / 2.0;
        TowerPath {
            points: if self.rib.is_some() {
                let mut pts: Vec<Point> = self
                    .wall_polygon(z)
                    .iter()
                    .map(|&(x, y)| self.place_point(x, y))
                    .collect();
                if let Some(&p) = pts.first() {
                    pts.push(p);
                }
                pts
            } else {
                self.ring(h)
            },
            width_mm: to_f32(self.wall_w),
            speed_mm_s: to_f32(if first { self.first_speed } else { self.wall_speed }),
            flow: 1.0,
        }
    }

    /// What fills the depth a layer's purges leave free, so the purges of the layers above have
    /// something to stand on (Orca: `WipeTower::finish_block` and `finish_layer_new`, `WipeTower2::
    /// finish_layer`): an outline round the free box, then on the first layer solid rows, and above
    /// it an inverse U with lines across the box about `wipe_tower_bridging` apart (10 mm on a type
    /// 1 tower). `used_rows` is how many purge rows the layer printed. Empty when no room is left.
    pub(crate) fn fill(&self, cfg: &PrintConfig, used_rows: f64, first: bool) -> Vec<TowerPath> {
        let w = self.wall_w;
        let (x0, x1) = (1.5 * w, self.width - 1.5 * w);
        let y0 = if used_rows > 0.0 {
            2.0 * w + used_rows * self.spacing
        } else {
            1.5 * w
        };
        let y1 = self.depth - 1.5 * w;
        if y1 - y0 <= 1e-4 || x1 - x0 <= 4.0 * w {
            return Vec::new();
        }
        // A tool changer's tower fills at the purge speed (Orca's and `PrusaSlicer`'s `finish_layer` use the infill speed there).
        let speed = to_f32(if first {
            self.first_speed
        } else if saves_on_last_wipe(cfg) {
            self.purge_speed
        } else {
            self.wall_speed
        });
        let path = |pts: Vec<(f64, f64)>| TowerPath {
            points: pts.into_iter().map(|(x, y)| self.place_point(x, y)).collect(),
            width_mm: to_f32(w),
            speed_mm_s: speed,
            flow: 1.0,
        };
        let mut out = vec![path(vec![(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)])];
        let dy = y1 - y0 - w;
        if dy <= w {
            return out;
        }
        let (mut left, mut right) = (x0 + 2.0 * w, x1 - 2.0 * w);
        if first {
            // Solid rows touching the outline.
            let start = left;
            left -= w;
            right += w;
            let n = (dy / w).floor().max(2.0);
            let step = (dy - w) / (n - 1.0);
            let mut pts = vec![(start, y0)];
            let mut y = y0 + w;
            let (mut k, mut to_right) = (0.0, true);
            while k < n {
                let x_now = pts.last().map_or(start, |p| p.0);
                pts.push((x_now, y));
                pts.push((if to_right { right } else { left }, y));
                y += step;
                k += 1.0;
                to_right = !to_right;
            }
            let x_now = pts.last().map_or(start, |p| p.0);
            pts.push((x_now, y1));
            out.push(path(pts));
            return out;
        }
        let bridging = if type1(cfg) {
            10.0
        } else {
            cfg.raw_number("wipe_tower_bridging", 10.0).max(1.0)
        };
        out.push(path(vec![(left, y0), (left, y1)]));
        let n = 1.0 + ((right - left) / bridging).floor();
        let dx = (right - left) / n;
        let (mut i, mut down) = (1.0, true);
        while i <= n {
            let x = left + dx * i;
            out.push(path(if down {
                vec![(x, y1), (x, y0)]
            } else {
                vec![(x, y0), (x, y1)]
            }));
            i += 1.0;
            down = !down;
        }
        out
    }

    /// The closed rectangle `inset` mm inside the tower's edge (negative: outside), turned by the
    /// tower's rotation.
    fn ring(&self, inset: f64) -> Vec<Point> {
        let (x0, y0, x1, y1) = (inset, inset, self.width - inset, self.depth - inset);
        [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
            .iter()
            .map(|&(x, y)| self.place_point(x, y))
            .collect()
    }

    /// A point in the tower's own frame (from its front left corner) on the plate.
    fn place_point(&self, x: f64, y: f64) -> Point {
        let (s, c) = self.angle.to_radians().m_sin_cos();
        // orca moves the rib tower after turning it (`transform_wt_pt`)
        let (ox, oy) = self.rib.map_or((0.0, 0.0), |r| r.offset);
        Point::from_mm(self.x + ox + x * c - y * s, self.y + oy + x * s + y * c)
    }

    /// Orca's brim chamfer on a type 1 tower (`WipeTower::finish_layer_new`): loops one bead spacing apart
    /// round the wall, as many as fit in `prime_tower_brim_width` on the first layer, then at most 3 mm of
    /// them, one fewer on each layer above (`above` layers over the first). `height` sizes a negative brim.
    pub(crate) fn chamfer(&self, above: u32, layer_h: f64, z: f64, height: f64) -> Vec<TowerPath> {
        let width = if self.brim < 0.0 {
            (height / 100.0).min(1.0) * 8.0
        } else {
            self.brim
        };
        let spacing = self.wall_w - layer_h * (1.0 - std::f64::consts::FRAC_PI_4);
        if width <= 0.0 || spacing <= 0.0 {
            return Vec::new();
        }
        #[allow(clippy::cast_possible_truncation, reason = "a loop count")]
        let mut loops = ((width + spacing / 2.0) / spacing).floor() as i64;
        if above > 0 {
            #[allow(clippy::cast_possible_truncation, reason = "a loop count")]
            let most = (3.0 / spacing).floor() as i64;
            loops = loops.min(most) - i64::from(above);
        }
        let mut ring: crate::perimeters::Shapes = vec![vec![ring_int(&self.wall_polygon(z))]];
        let mut out = Vec::new();
        for _ in 0..loops.max(0) {
            ring = crate::perimeters::offset(&ring, crate::geom::mm(spacing));
            let Some(outer) = ring.first().and_then(|s| s.first()) else {
                break;
            };
            let mut pts: Vec<Point> = outer
                .iter()
                .map(|q| self.place_point(from_int(q.x), from_int(q.y)))
                .collect();
            if let Some(&p) = pts.first() {
                pts.push(p);
            }
            out.push(TowerPath {
                points: pts,
                width_mm: to_f32(self.wall_w),
                speed_mm_s: to_f32(if above == 0 {
                    self.first_speed
                } else {
                    self.wall_speed
                }),
                flow: 1.0,
            });
        }
        out
    }

    /// The brim around the first layer: loops one bead spacing apart outside the wall, as many as
    /// fit in `prime_tower_brim_width` (`WipeTower2::finish_layer`). `height` is the tower's height,
    /// which sizes the brim when the width is negative (up to 8 mm at 100 mm).
    pub(crate) fn brim(&self, first_h: f64, height: f64) -> Vec<TowerPath> {
        let width = if self.brim < 0.0 {
            (height / 100.0).min(1.0) * 8.0
        } else {
            self.brim
        };
        let spacing = self.wall_w - first_h * (1.0 - std::f64::consts::FRAC_PI_4);
        if width <= 0.0 || spacing <= 0.0 {
            return Vec::new();
        }
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a loop count"
        )]
        let loops = ((width + spacing / 2.0) / spacing).floor().max(0.0) as usize;
        (1..=loops)
            .map(|k| {
                #[allow(clippy::cast_precision_loss, reason = "a loop count")]
                let inset = self.wall_w / 2.0 - k as f64 * spacing;
                TowerPath {
                    points: self.ring(inset),
                    width_mm: to_f32(self.wall_w),
                    speed_mm_s: to_f32(self.first_speed),
                    flow: 1.0,
                }
            })
            .collect()
    }

    /// The tower's footprint on the plate with its rotation and `margin` mm around it:
    /// `[min x, min y, max x, max y]` from its corner.
    fn reach(&self, margin: f64) -> [f64; 4] {
        let (s, c) = self.angle.to_radians().m_sin_cos();
        let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        // a rib wall reaches its offset past the box on every side, and the tower moves by it
        let (ox, oy) = self.rib.map_or((0.0, 0.0), |r| r.offset);
        let (w, d) = (self.width + 2.0 * ox, self.depth + 2.0 * oy);
        for (x, y) in [
            (-margin, -margin),
            (w + margin, -margin),
            (w + margin, d + margin),
            (-margin, d + margin),
        ] {
            let (px, py) = (x * c - y * s, x * s + y * c);
            b = [b[0].min(px), b[1].min(py), b[2].max(px), b[3].max(py)];
        }
        b
    }

    /// A zigzag of rows that extrudes `volume` mm3 at layer height `layer_h`, one row spacing apart,
    /// from row `start` of the tower's depth (the purges of one layer stack, as `WipeTower2` plans each
    /// tool change's box below the next). Returns one path per row (each with the step to the next
    /// row) and the rows taken. The rows speed up as Orca's do (`WipeTower::toolchange_wipe_new`,
    /// `WipeTower2::toolchange_Wipe`): a third of the target speed, then 0.375, 0.458 and 0.875 of
    /// it, then 50 mm/min more a row up to the target, which is 80 mm/s on a type 1 tower and the
    /// purge speed on a type 2 one (the first layer's speed on the first layer).
    pub(crate) fn purge(&self, volume: f64, layer_h: f64, first: bool, start: f64) -> (Vec<TowerPath>, f64) {
        self.purge_lead(volume, layer_h, first, start, None)
    }

    /// [`Self::purge`] that first finishes the row a tool changer's ramming left off (`lead`: where the
    /// ramming ended across the tower and whether it was heading right), as Orca's and `PrusaSlicer`'s wipe
    /// takes the rest of the ramming's row (`first_wipe_line`) before its own rows.
    pub(crate) fn purge_lead(
        &self,
        volume: f64,
        layer_h: f64,
        first: bool,
        start: f64,
        lead: Option<(f64, bool)>,
    ) -> (Vec<TowerPath>, f64) {
        // A type 1 tower's rows run across its cleaning box, a bead in from each side, whole rows until the
        // length is purged (`WipeTower::toolchange_wipe_new`); a type 2 tower's stop short and the last row
        // is trimmed to the volume.
        let edge = if self.type1 {
            self.wall_w
        } else {
            2.0 * self.wall_w
        };
        let (x0, x1) = (edge, self.width - edge);
        let row_len = x1 - x0;
        let area = bead(self.wipe_w, layer_h);
        let mut pts = Vec::new();
        let mut y = 2.0 * self.wall_w + start * self.spacing;
        let mut left = true;
        let mut volume = volume;
        let mut lead_row = false;
        if let Some((x, right)) = lead {
            let x = x.clamp(x0, x1);
            let to = if right { x1 } else { x0 };
            if (to - x).abs() > 1e-3 {
                let ly = y - 0.5 * self.spacing;
                pts.push((x, ly));
                pts.push((to, ly));
                volume -= (to - x).abs() * area;
                lead_row = true;
            }
            // The rows go on from the edge the leading row ended at, back the other way.
            left = !right;
        }
        let n = (volume.max(0.0) / (row_len * area))
            .ceil()
            .max(if lead_row { 0.0 } else { 1.0 });
        // The count is small (a purge is tens of rows).
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "row count is small"
        )]
        for _ in 0..(n as usize) {
            let (a, b) = if left { (x0, x1) } else { (x1, x0) };
            pts.push((a, y));
            pts.push((b, y));
            y += self.spacing;
            left = !left;
        }
        // The last row is trimmed so the total matches the volume asked for.
        let full = n * row_len * bead(self.wipe_w, layer_h);
        if !self.whole_rows && n > 0.0 && full > volume + 1e-9 && pts.len() >= 2 {
            let short = (full - volume) / bead(self.wipe_w, layer_h);
            if let (Some(a), Some(b)) = (pts.get(pts.len() - 2).copied(), pts.last().copied()) {
                let len = (b.0 - a.0).abs();
                let keep = (len - short).max(0.0) / len.max(1e-9);
                if let Some(last) = pts.last_mut() {
                    last.0 = a.0 + (b.0 - a.0) * keep;
                }
            }
        }
        let target = if self.type1 {
            if first { self.first_speed.min(80.0) } else { 80.0 }
        } else if first {
            self.first_speed
        } else {
            self.purge_speed
        };
        let mut speed = 0.33 * target;
        let mut paths = Vec::new();
        for (k, row) in pts.chunks(2).enumerate() {
            if k > 0 {
                speed = if speed < 0.34 * target {
                    0.375 * target
                } else if speed < 0.377 * target {
                    0.458 * target
                } else if speed < 0.46 * target {
                    0.875 * target
                } else {
                    (speed + 50.0 / 60.0).min(target)
                };
            }
            let mut row_pts: Vec<(f64, f64)> = row.to_vec();
            // The step up to the next row prints at this row's speed.
            if let Some(next) = pts.get(2 * k + 2)
                && let Some(end) = row_pts.last().copied()
            {
                row_pts.push((end.0, next.1));
            }
            paths.push(TowerPath {
                points: row_pts.into_iter().map(|(x, y)| self.place_point(x, y)).collect(),
                width_mm: to_f32(self.wipe_w),
                speed_mm_s: to_f32(speed),
                flow: 1.0,
            });
        }
        (paths, n)
    }

    /// What the old filament rams out before a change ([`ChangePurge::ram`], filament `from`): lines across
    /// the tower from row `start`, the ramming bead wide ([`ram_width`]). Bambu Studio's nozzle change prints
    /// whole lines at the filament's ramming flow (`WipeTower::nozzle_change_new`); a tool changer's ramming
    /// (`toolchange_Unload` with `filament_multitool_ramming`) stops at the volume, at
    /// `filament_multitool_ramming_flow`. Returns the paths, the tower rows taken and, for a tool changer,
    /// where the last line ended across the tower and whether it was heading right (the wipe's lead).
    pub(crate) fn ramming(
        &self,
        cfg: &PrintConfig,
        p: ChangePurge,
        from: u8,
        layer_h: f64,
        start: f64,
    ) -> (Vec<TowerPath>, f64, Option<(f64, bool)>) {
        let w = ram_width(cfg, p.nozzle_change);
        let (x0, x1) = (w, (self.width - w).max(w + 1.0));
        let row_len = x1 - x0;
        let area = bead(w, layer_h);
        let lines = (p.ram / (row_len * area)).ceil().max(1.0);
        let step = w * if p.nozzle_change { 1.25 } else { 1.0 };
        let flow = if p.nozzle_change {
            let v = per_slot_raw(cfg, "filament_ramming_volumetric_speed", from, -1.0);
            if v > 0.0 {
                v
            } else {
                per_slot_raw(cfg, "filament_max_volumetric_speed", from, 15.0)
            }
        } else {
            per_slot_raw(cfg, "filament_multitool_ramming_flow", from, 10.0)
        };
        let speed = (flow.max(0.5) / area).clamp(5.0, 300.0);
        let mut y = 2.0 * self.wall_w + start * self.spacing + (w - self.wall_w) / 2.0;
        let mut pts: Vec<(f64, f64)> = Vec::new();
        let mut left_to_right = true;
        let mut remaining = p.ram;
        let mut end = None;
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a line count"
        )]
        for _ in 0..(lines as usize) {
            let (a, b) = if left_to_right { (x0, x1) } else { (x1, x0) };
            // A tool changer's last line stops at the volume.
            let frac = if p.nozzle_change {
                1.0
            } else {
                (remaining / (row_len * area)).clamp(0.0, 1.0)
            };
            pts.push((a, y));
            pts.push((a + (b - a) * frac, y));
            end = Some((a + (b - a) * frac, b > a));
            remaining -= row_len * area * frac;
            y += step;
            left_to_right = !left_to_right;
        }
        let rows = (lines * step / self.spacing).ceil();
        let path = TowerPath {
            points: pts.into_iter().map(|(x, y)| self.place_point(x, y)).collect(),
            width_mm: to_f32(w),
            speed_mm_s: to_f32(speed),
            flow: 1.0,
        };
        (vec![path], rows, end.filter(|_| !p.nozzle_change))
    }
}

impl Tower {
    /// Orca's `WipeTower2::save_on_last_wipe` for a layer's first purge of `volume` mm3 (type 2 towers):
    /// what finishing the layer on this tower extrudes anyway (its wall and the fill over the purges, from
    /// row `start`) comes off the purge, down to `filament_minimal_purge_on_wipe_tower` of the new filament
    /// `to`.
    pub(crate) fn saved_wipe(
        &self,
        cfg: &PrintConfig,
        volume: f64,
        h: f64,
        first: bool,
        start: f64,
        to: u8,
    ) -> f64 {
        let floor = per_slot_raw(cfg, "filament_minimal_purge_on_wipe_tower", to, 15.0).max(0.0);
        let wall = path_volume(&self.wall(first, 0.0), h);
        let mut v = volume;
        for _ in 0..3 {
            let rows = self.purge(v, h, first, start).1;
            let fill: f64 = self
                .fill(cfg, start + rows, first)
                .iter()
                .map(|f| path_volume(f, h))
                .sum();
            v = floor.max(volume - wall - fill);
        }
        v
    }
}

/// Filament a tower path extrudes at layer height `h`, mm3.
pub(crate) fn path_volume(p: &TowerPath, h: f64) -> f64 {
    let len: f64 = p
        .points
        .windows(2)
        .map(|w| w.first().zip(w.get(1)).map_or(0.0, |(a, b)| a.dist_mm(*b)))
        .sum();
    len * bead(f64::from(p.width_mm), h) * f64::from(p.flow)
}

/// The priming of one filament at the start of a print on a single extruder for several filaments
/// (`single_extruder_multi_material_priming`, `WipeTower2::prime`): each filament in turn wipes
/// `volume` mm3 in rows across its own section along the front of the bed, sections
/// `min(0.9 bed width / count, 60)` mm wide from 2 percent of the bed's width. `k` is the filament's
/// place in the priming order of `count`. The lean tower has no ramming or unloading, so only the
/// wipe is printed.
pub(crate) fn prime_section(
    cfg: &PrintConfig,
    k: usize,
    count: usize,
    volume: f64,
    first_h: f64,
) -> TowerPath {
    let bed = cfg.bed_rect();
    let bed_w = bed[2] - bed[0];
    #[allow(clippy::cast_precision_loss, reason = "a filament count")]
    let section = (0.9 * bed_w / count.max(1) as f64).min(60.0);
    let w = cfg.nozzle_diameter * 1.25;
    #[allow(clippy::cast_precision_loss, reason = "a filament count")]
    let x0 = bed[0] + 0.02 * bed_w + k as f64 * section;
    let x1 = x0 + section;
    let mut y = bed[1] + 0.01 + w / 2.0;
    let per_row = section * bead(w, first_h);
    let mut left = volume.max(0.0);
    let mut pts = vec![Point::from_mm(x0, y)];
    let mut at_left = true;
    while left > 1e-9 && y < bed[1] + 100.0 {
        let frac = (left / per_row).min(1.0);
        let x = if at_left {
            x0 + section * frac
        } else {
            x1 - section * frac
        };
        pts.push(Point::from_mm(x, y));
        left -= per_row * frac;
        if left > 1e-9 {
            y += w;
            pts.push(Point::from_mm(x, y));
        }
        at_left = !at_left;
    }
    TowerPath {
        points: pts,
        width_mm: to_f32(w),
        speed_mm_s: to_f32(if cfg.initial_layer_speed > 0.0 {
            cfg.initial_layer_speed
        } else {
            30.0
        }),
        flow: 1.0,
    }
}

/// The rows the tower needs: the most any layer up to `top` takes for its tool changes at that
/// layer's height, its purges stacked (`WipeTower2` sizes the tower by its deepest layer). `orders`
/// are the layers' filaments in print order and `thickness` their heights.
pub(crate) fn plan_rows(
    cfg: &PrintConfig,
    width: f64,
    tools: u8,
    orders: &[Vec<u8>],
    thickness: &dyn Fn(usize) -> f64,
    top: usize,
) -> f64 {
    let rows = plan_rows_with(cfg, width, tools, orders, thickness, top, None);
    if !saves_on_last_wipe(cfg) {
        return rows;
    }
    // Orca plans a type 2 tower again with each layer's first purge cut by what finishing the layer extrudes
    // on the tower first planned (`WipeTower2::generate`: `save_on_last_wipe`, then `plan_tower`).
    match Tower::new(cfg, tools, rows) {
        Some(t0) => plan_rows_with(
            cfg,
            width,
            tools,
            orders,
            thickness,
            top,
            Some(&t0.shaped(width, 0.0)),
        ),
        None => rows,
    }
}

/// [`plan_rows`] without the save of a type 2 tower: the depth Orca plans first, which the save is measured on.
pub(crate) fn plan_rows_unsaved(
    cfg: &PrintConfig,
    width: f64,
    tools: u8,
    orders: &[Vec<u8>],
    thickness: &dyn Fn(usize) -> f64,
    top: usize,
) -> f64 {
    plan_rows_with(cfg, width, tools, orders, thickness, top, None)
}

fn plan_rows_with(
    cfg: &PrintConfig,
    width: f64,
    tools: u8,
    orders: &[Vec<u8>],
    thickness: &dyn Fn(usize) -> f64,
    top: usize,
    saved: Option<&Tower>,
) -> f64 {
    let nozzle = cfg.nozzle_diameter;
    let wall_w = nozzle * 1.25;
    let extra_flow = (cfg.raw_number("wipe_tower_extra_flow", 100.0) / 100.0).clamp(0.5, 3.0);
    let wipe_w = if type1(cfg) {
        wall_w
    } else {
        wall_w * 1.15 * extra_flow
    };
    let row_len = width.max(5.0) - 4.0 * wall_w;
    let mut cur = 0u8;
    let mut most = 1.0f64;
    for (l, order) in orders.iter().enumerate().take(top + 1) {
        let h = thickness(l);
        let mut rows = 0.0;
        let mut first_change = true;
        for &t in order {
            if cur != 0 && t != cur {
                let p = change_purge(cfg, tools, cur, t);
                let mut v = p.wipe;
                if let Some(t0) = saved.filter(|_| first_change) {
                    v = t0.saved_wipe(cfg, v, h, l == 0, rows, t);
                }
                first_change = false;
                rows += (v / (row_len * bead(wipe_w, h))).ceil().max(1.0);
                if p.ram > 0.0 {
                    rows += ram_rows(cfg, p, width, h);
                }
            }
            cur = t;
        }
        most = most.max(rows);
    }
    most
}

/// Orca's rib tower size, width and depth in mm (`WipeTower::plan_tower_new` with `wipe_tower_wall_type` rib,
/// then `update_all_layer_depth`), or None for any other tower. Each tool change purges `prime_volume` in rows
/// of wall-width beads across the tower; the deepest layer's rows at `prime_tower_width`, plus a bead, give an
/// area that a square `prime_tower_infill_gap` times as large replaces, rounded up to whole beads. The depth is
/// then the deepest layer's rows at that width, `prime_tower_infill_gap` apart, plus a bead. `orders`,
/// `thickness` and `top` as [`plan_rows`].
pub(crate) fn rib_size(
    cfg: &PrintConfig,
    tools: u8,
    orders: &[Vec<u8>],
    thickness: &dyn Fn(usize) -> f64,
    top: usize,
) -> Option<(f64, f64)> {
    if !square(cfg) {
        return None;
    }
    let pw = cfg.nozzle_diameter * 1.25;
    let gap = (cfg.raw_number("prime_tower_infill_gap", 150.0) / 100.0).max(0.01);
    let width = cfg.raw_number("prime_tower_width", 35.0).max(5.0);
    // The depth the layer that purges most takes at tower width `w` (Orca `plan_toolchange`, the blocks of
    // `generate_wipe_tower_blocks`).
    let deepest = |w: f64| -> f64 {
        let line = w - 2.0 * pw;
        if line <= 1e-9 {
            return 0.0;
        }
        let mut cur = 0u8;
        let mut most = 0.0f64;
        for (l, order) in orders.iter().enumerate().take(top + 1) {
            let h = thickness(l);
            let mut d = 0.0;
            for &t in order {
                if cur != 0 && t != cur {
                    let p = change_purge(cfg, tools, cur, t);
                    let length = p.wipe / bead(pw, h);
                    d += (length / line).ceil() * pw;
                    if p.ram > 0.0 {
                        d += ram_rows(cfg, p, w, h) * pw;
                    }
                }
                cur = t;
            }
            most = most.max(d);
        }
        most
    };
    let side = (((deepest(width) + pw) * width * gap).sqrt() / pw).ceil() * pw;
    let block = deepest(side);
    (block > 0.0).then_some((side, block * gap + pw))
}

/// The bead width of the rows an old filament rams out before a change: Bambu Studio's nozzle change width
/// (`nozzle_diameter_to_nozzle_change_width`), else twice the tower's wall bead (the multitool ramming line).
fn ram_width(cfg: &PrintConfig, nozzle_change: bool) -> f64 {
    let d = cfg.nozzle_diameter;
    if nozzle_change {
        let table = [(0.2, 0.5), (0.4, 1.0), (0.6, 1.2), (0.8, 1.4)];
        table
            .iter()
            .find(|(n, _)| (n - d).abs() < 1e-3)
            .map_or(2.5 * d, |t| t.1)
    } else {
        2.0 * d * 1.25
    }
}

/// Tower rows (at the tower's own row spacing) the ramming of one change takes on a tower `width` wide.
fn ram_rows(cfg: &PrintConfig, p: ChangePurge, width: f64, h: f64) -> f64 {
    let wall_w = cfg.nozzle_diameter * 1.25;
    let w = ram_width(cfg, p.nozzle_change);
    let row_len = (width - 2.0 * w).max(1.0);
    let lines = (p.ram / (row_len * bead(w, h))).ceil().max(1.0);
    let spacing = if type1(cfg) {
        wall_w
            * cfg
                .raw_number("prime_tower_infill_gap", 150.0)
                .clamp(100.0, 300.0)
            / 100.0
    } else {
        wall_w
    };
    (lines * w * if p.nozzle_change { 1.25 } else { 1.0 } / spacing).ceil()
}

/// Cross-section of a bead `w` wide and `h` tall with rounded edges, mm2.
fn bead(w: f64, h: f64) -> f64 {
    crate::gcode::bead_area(w, h)
}

#[allow(clippy::cast_possible_truncation, reason = "widths are small")]
/// A ring of mm points in the clipper units.
fn ring_int(p: &[(f64, f64)]) -> Vec<i_overlay::i_float::int::point::IntPoint<i32>> {
    p.iter()
        .map(|&(x, y)| i_overlay::i_float::int::point::IntPoint::new(crate::geom::mm(x), crate::geom::mm(y)))
        .collect()
}

fn from_int(v: i32) -> f64 {
    f64::from(v) / crate::geom::SCALE
}

/// Orca's minimum tower depth for a tower `height` tall (`WipeTower::get_limit_depth_by_height`), interpolated
/// between 5 mm at 5 mm, 20 at 100, 40 at 250 and 60 at 350.
fn limit_depth_by_height(height: f64) -> f64 {
    const TABLE: [(f64, f64); 4] = [(5.0, 5.0), (100.0, 20.0), (250.0, 40.0), (350.0, 60.0)];
    let mut prev: Option<(f64, f64)> = None;
    for &(h, d) in &TABLE {
        if let Some((ph, pd)) = prev {
            if h > height {
                return pd + (height - ph) / (h - ph) * (d - pd);
            }
        } else if h >= height {
            return d;
        }
        prev = Some((h, d));
    }
    TABLE.last().map_or(60.0, |t| t.1)
}

/// Orca's `WipeTower::rounding_polygon`: every corner turning between 30 and 150 degrees becomes an arc of
/// 20 steps between the points `rounding` mm (or under half the edges) either side of it.
fn rounded(poly: &[(f64, f64)], rounding: f64) -> Vec<(f64, f64)> {
    let n = poly.len();
    if n < 3 {
        return poly.to_vec();
    }
    let tol = (30.0f64).to_radians().m_cos().abs();
    let mut out: Vec<(f64, f64)> = Vec::with_capacity(n * 21);
    for i in 0..n {
        let at = |k: usize| poly.get(k % n).copied().unwrap_or_default();
        let (a, b, c) = (at(i + n - 1), at(i), at(i + 1));
        let (ab_len, bc_len) = ((b.0 - a.0).m_hypot(b.1 - a.1), (c.0 - b.0).m_hypot(c.1 - b.1));
        if ab_len <= 0.0 || bc_len <= 0.0 {
            out.push(b);
            continue;
        }
        let ab = ((b.0 - a.0) / ab_len, (b.1 - a.1) / ab_len);
        let bc = ((c.0 - b.0) / bc_len, (c.1 - b.1) / bc_len);
        let cos = (ab.0 * bc.0 + ab.1 * bc.1).clamp(-1.0, 1.0);
        if cos.abs() >= tol {
            out.push(b);
            continue;
        }
        let ccw = ab.0 * bc.1 - ab.1 * bc.0 > 0.0;
        let r = rounding.min(ab_len / 2.1).min(bc_len / 2.1);
        let left = (b.0 - ab.0 * r, b.1 - ab.1 * r);
        let right = (b.0 + bc.0 * r, b.1 + bc.1 * r);
        let half = cos.m_acos() / 2.0;
        let (dx, dy) = (right.0 - left.0, right.1 - left.1);
        let len = dx.m_hypot(dy);
        let mut dir = (-dy / len, dx / len);
        if !ccw {
            dir = (-dir.0, -dir.1);
        }
        let dis = r / half.m_sin();
        let center = (b.0 + dir.0 * dis, b.1 + dir.1 * dis);
        let radius = (left.0 - center.0).m_hypot(left.1 - center.1);
        let start = (left.1 - center.1).m_atan2(left.0 - center.0);
        let end = (right.1 - center.1).m_atan2(right.0 - center.0);
        let tau = std::f64::consts::TAU;
        let sweep = if ccw {
            (end - start).rem_euclid(tau)
        } else {
            -(start - end).rem_euclid(tau)
        };
        for j in 0..20 {
            let t = start + f64::from(j) / 20.0 * sweep;
            let (s, co) = t.m_sin_cos();
            out.push((center.0 + radius * co, center.1 + radius * s));
        }
        out.push(right);
    }
    out.dedup_by(|p, q| (p.0 - q.0).abs() < 1e-9 && (p.1 - q.1).abs() < 1e-9);
    out
}

#[allow(clippy::cast_possible_truncation)]
fn to_f32(v: f64) -> f32 {
    v as f32
}

/// Sets the variables a profile's tool change G-code reads: the temperatures and extrusion feed
/// rates of the old and new filament and the flush lengths. `prev` and `next` are zero-based slots;
/// `flush_from` is the filament the new filament's nozzle holds (the old filament on a printer with one
/// nozzle), `None` when the nozzle is empty and nothing needs flushing.
pub(crate) fn tool_change_vars(
    ctx: &mut crate::template::Context<'_>,
    cfg: &PrintConfig,
    tools: u8,
    prev: i64,
    next: i64,
    flush_from: Option<i64>,
    on_tower: bool,
) {
    let slot = |i: i64| u8::try_from(i.max(0) + 1).unwrap_or(1);
    let area = std::f64::consts::PI * (cfg.filament_diameter / 2.0).m_powi(2);
    // Feed rate that melts filament at the filament's volumetric limit, mm/min.
    let feed = |i: i64| {
        let v = per_slot_raw(cfg, "filament_max_volumetric_speed", slot(i), 15.0);
        (v / area * 60.0).round()
    };
    for (k, i) in [("old_filament_temp", prev), ("new_filament_temp", next)] {
        ctx.set_num(k, PrintConfig::per_slot(&cfg.nozzle_temperature, slot(i), 220.0));
    }
    ctx.set_num(
        "filament_extruder_id",
        f64::from(i32::try_from(next.max(0)).unwrap_or(0)),
    );
    ctx.set_num("old_filament_e_feedrate", feed(prev));
    ctx.set_num("new_filament_e_feedrate", feed(next));
    // Orca (`GCode::set_extruder`): the flush is the matrix entry times the multiplier, less what
    // the new filament's grab extrudes, split into steps of about 135 mm3, at most four.
    let asked = flush_from.map_or(0.0, |from| {
        flush_entry(
            cfg,
            tools,
            usize::try_from(from.max(0)).unwrap_or(0),
            usize::try_from(next.max(0)).unwrap_or(0),
        )
        .unwrap_or_else(|| cfg.raw_number("prime_volume", 45.0))
            * cfg.raw_number("flush_multiplier", 1.0)
    });
    let grab = per_slot_raw(cfg, "grab_length", slot(next), 0.0) * 2.4;
    let mut volume = (asked - grab).max(0.0);
    // A type 1 tower's change flushes at least 100 mm3 into the chute (`WipeTowerIntegration::
    // append_tcr`, `g_min_purge_volume`).
    if on_tower && type1(cfg) && volume > 1e-4 {
        volume = volume.max(100.0);
    }
    let length = volume / area;
    ctx.set_num("flush_length", length);
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a step count"
    )]
    let steps = ((volume / 135.0).round() as usize).min(4);
    for i in 1..=4usize {
        #[allow(clippy::cast_precision_loss, reason = "a step count")]
        let v = if i <= steps { length / steps as f64 } else { 0.0 };
        ctx.set_num(&format!("flush_length_{i}"), v);
    }
    for (k, i) in [
        ("old_retract_length_toolchange", prev),
        ("new_retract_length_toolchange", next),
    ] {
        ctx.set_num(k, per_slot_raw(cfg, "retract_length_toolchange", slot(i), 0.0));
    }
    ctx.set_num("old_retract_length", cfg.filament_retraction_length(slot(prev)));
}

/// A per-filament number from the raw settings (a list by slot, or one number).
pub(crate) fn per_slot_raw(cfg: &PrintConfig, key: &str, slot: u8, fallback: f64) -> f64 {
    let num = |v: &serde_json::Value| match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    };
    match cfg.raw.get(key) {
        Some(serde_json::Value::Array(a)) => a
            .get(usize::from(slot.max(1) - 1))
            .or_else(|| a.last())
            .and_then(num)
            .unwrap_or(fallback),
        Some(v) => num(v).unwrap_or(fallback),
        None => fallback,
    }
}

/// A true/false setting from the raw map (`1`, `true` or a number other than 0).
pub(crate) fn flag(cfg: &PrintConfig, key: &str) -> bool {
    flag_or(cfg, key, false)
}

/// Like `flag`, with `default` when the setting is absent.
pub(crate) fn flag_or(cfg: &PrintConfig, key: &str, default: bool) -> bool {
    match cfg.raw.get(key) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::Number(n)) => n.as_f64().is_some_and(|v| v != 0.0),
        Some(serde_json::Value::String(s)) => s == "1" || s == "true",
        // A filament setting is a list, one value per filament; the first one counts, a switch included.
        Some(serde_json::Value::Array(a)) => a.first().is_some_and(|v| {
            matches!(v, serde_json::Value::String(s) if s == "1" || s == "true")
                || matches!(v, serde_json::Value::Bool(true))
                || v.as_f64().is_some_and(|x| x != 0.0)
        }),
        _ => default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_switch_in_a_list_reads_as_itself() {
        // Filament settings come as lists, a switch as `[true]`: it is on, as `["1"]` and `[1]` are.
        for (v, on) in [
            (serde_json::json!([true]), true),
            (serde_json::json!([false]), false),
            (serde_json::json!(["1"]), true),
            (serde_json::json!([0]), false),
        ] {
            let c = cfg(&[("enable_overhang_speed", v.clone())]);
            assert_eq!(flag_or(&c, "enable_overhang_speed", !on), on, "{v}");
        }
    }

    fn cfg(pairs: &[(&str, serde_json::Value)]) -> PrintConfig {
        // The engine's own values: these tests set what they check.
        let mut c = PrintConfig::builtin();
        for (k, v) in pairs {
            c.raw.insert((*k).to_owned(), v.clone());
        }
        c
    }

    fn tower_cfg(extra: &[(&str, serde_json::Value)]) -> PrintConfig {
        let mut pairs = vec![
            ("enable_prime_tower", serde_json::json!(true)),
            ("wipe_tower_x", serde_json::json!(15)),
            ("wipe_tower_y", serde_json::json!(220)),
            ("prime_tower_width", serde_json::json!(35)),
            ("prime_tower_brim_width", serde_json::json!(3)),
            ("prime_tower_auto_position", serde_json::json!(false)),
        ];
        pairs.extend(extra.iter().cloned());
        cfg(&pairs)
    }

    fn part(x0: f64, y0: f64, x1: f64, y1: f64) -> crate::output::ObjectFootprint {
        crate::output::ObjectFootprint {
            hull: vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
            ..Default::default()
        }
    }

    /// Rows for a purge of `volume` mm3 per layer at 0.2 mm, at tower width `w`.
    fn rows_for(volume: f64) -> impl Fn(f64) -> f64 {
        move |w: f64| (volume / ((w - 2.5) * bead(0.575, 0.2))).ceil()
    }

    #[test]
    fn a_tower_past_the_back_edge_is_pulled_inside_by_its_planned_depth() {
        // The app's two-color P1S plate: a 35 mm tower at x 15, y 220 whose purges need about 46 mm
        // of depth. It moves forward just enough to stay on the 256 mm bed, x unchanged.
        let c = tower_cfg(&[]);
        let rows = rows_for(330.0);
        let Ok(Some(p)) = place(&c, 2, &rows, None, &[part(96.0, 117.0, 160.0, 139.0)], 50.0) else {
            panic!("placed")
        };
        let Some(t) = p.tower(&c, 2) else { panic!("tower") };
        assert_eq!(p.reason, TowerReason::MovedOntoBed);
        assert!((p.origin[0] - 15.0).abs() < 1e-9, "x {}", p.origin[0]);
        let r = t.reach(3.0);
        assert!(
            (p.origin[1] + r[3] - 255.0).abs() < 1e-9,
            "back edge {} of a {:.1} mm deep tower",
            p.origin[1] + r[3],
            t.depth
        );
        assert!(t.depth > 40.0);
    }

    #[test]
    fn auto_placement_stays_clear_of_the_cutter_corner_and_the_purge_line() {
        // A P1S: the cutter zone in the front left corner and a purge line along the front edge.
        let c = tower_cfg(&[
            ("prime_tower_auto_position", serde_json::json!(true)),
            (
                "bed_exclude_area",
                serde_json::json!(["0x0", "18x0", "18x28", "0x28"]),
            ),
            (
                "machine_start_gcode",
                serde_json::json!("G1 X18 Y1 Z0.8 F18000\nG1 Z0.2\nG0 X240 E15\nG0 Y11 E0.7\n"),
            ),
        ]);
        // The part covers the whole back half, so the tower must go to the front.
        let parts = [part(5.0, 120.0, 250.0, 250.0)];
        let Ok(Some(p)) = place(&c, 2, &rows_for(60.0), None, &parts, 50.0) else {
            panic!("placed")
        };
        let Some(t) = p.tower(&c, 2) else { panic!("tower") };
        let r = t.reach(3.0);
        assert_eq!(p.reason, TowerReason::Auto);
        let (lx, ly, hx, hy) = (
            p.origin[0] + r[0],
            p.origin[1] + r[1],
            p.origin[0] + r[2],
            p.origin[1] + r[3],
        );
        assert!(ly >= 13.0, "clear of the purge line (front {ly})");
        assert!(lx >= 18.0 || ly >= 28.0, "clear of the cutter corner");
        assert!(hy <= 120.0 - 1.0, "clear of the part (back {hy})");
        // As close to the part as the brim allows: the back edge sits right in front of it.
        assert!(hy >= 110.0, "near the part (back {hy})");
        assert!(hx <= 255.0);
        // The same plate gives the same spot every time.
        let Ok(Some(again)) = place(&c, 2, &rows_for(60.0), None, &parts, 50.0) else {
            panic!("placed")
        };
        assert_eq!(p, again);
    }

    #[test]
    fn a_tower_too_deep_for_any_free_spot_gets_wider() {
        // Only a strip 70 mm deep is free at the front; the purge needs about 120 mm at 35 mm wide.
        let c = tower_cfg(&[("prime_tower_auto_position", serde_json::json!(true))]);
        let parts = [part(1.0, 75.0, 255.0, 255.0)];
        let Ok(Some(p)) = place(&c, 2, &rows_for(800.0), None, &parts, 50.0) else {
            panic!("placed")
        };
        let Some(t) = p.tower(&c, 2) else { panic!("tower") };
        assert_eq!(p.reason, TowerReason::Reshaped);
        assert!(
            p.width > 35.0 || (p.angle - 90.0).abs() < 1e-9,
            "width {} angle {}",
            p.width,
            p.angle
        );
        let r = t.reach(3.0);
        assert!(p.origin[1] + r[3] <= 75.0 - 1.0);
        // Nowhere at all: a part over the whole bed.
        assert!(
            place(
                &c,
                2,
                &rows_for(800.0),
                None,
                &[part(1.0, 1.0, 255.0, 255.0)],
                50.0
            )
            .is_err()
        );
    }

    #[test]
    fn a_bambu_rib_tower_is_a_square_as_deep_as_its_purges() {
        // Orca's type 1 rib tower ignores `prime_tower_width`: two changes a layer of 45 mm3 at 0.2 mm,
        // rows 0.75 mm apart, make a square of about 21 mm, and a tall one stands no narrower than
        // the height table asks.
        let c = cfg(&[
            ("enable_prime_tower", serde_json::json!(true)),
            ("printer_model", serde_json::json!("Bambu Lab P1S")),
            ("prime_tower_width", serde_json::json!(60)),
            ("prime_tower_auto_position", serde_json::json!(false)),
        ]);
        let rows = |w: f64| plan_rows(&c, w, 2, &[vec![1, 2, 1]], &|_| 0.2, 0);
        let Ok(Some(p)) = place(&c, 2, &rows, None, &[], 20.0) else {
            panic!("placed")
        };
        let Some(t) = p.tower(&c, 2) else { panic!("tower") };
        assert!(
            t.depth <= t.width && t.width - t.depth < 1.5,
            "{} x {}",
            t.width,
            t.depth
        );
        assert!(t.width > 15.0 && t.width < 30.0, "width {}", t.width);
        let Ok(Some(tall)) = place(&c, 2, &rows, None, &[], 250.0) else {
            panic!("placed")
        };
        assert!((tall.width - 40.0).abs() < 1e-9, "width {}", tall.width);
        assert!((min_side_by_height(175.0) - 30.0).abs() < 1e-9);
    }

    #[test]
    fn a_rib_tower_takes_orcas_size() {
        // One change a layer of 45 mm3 at 0.2 mm with 0.5 mm beads purges 492.3 mm: 15 rows at Orca's 35 mm
        // (7.5 mm deep), so the square is sqrt((7.5 + 0.5) * 35 * 1.5) = 20.49, 20.5 mm in whole beads; there
        // the purge takes 26 rows, 13 mm, 1.5 times as deep plus a bead: 20 mm.
        let c = cfg(&[
            ("enable_prime_tower", serde_json::json!(true)),
            ("printer_model", serde_json::json!("Bambu Lab A1")),
        ]);
        let Some((w, d)) = rib_size(&c, 2, &[vec![1, 2]], &|_| 0.2, 0) else {
            panic!("a rib tower")
        };
        assert!((w - 20.5).abs() < 1e-9 && (d - 20.0).abs() < 1e-9, "{w} x {d}");
        let rows = |w: f64| plan_rows(&c, w, 2, &[vec![1, 2]], &|_| 0.2, 0);
        let Ok(Some(p)) = place(&c, 2, &rows, Some((w, d)), &[], 60.0) else {
            panic!("placed")
        };
        let Some(t) = p.tower(&c, 2) else { panic!("tower") };
        assert!(
            (t.width - 20.5).abs() < 1e-9 && (t.depth - 20.0).abs() < 1e-9,
            "{} x {}",
            t.width,
            t.depth
        );
        // Its 26 rows fit the depth.
        let (_, n) = t.purge(45.0, 0.2, false, 0.0);
        assert!((n - 26.0).abs() < 1e-9, "{n} rows");
        assert!(
            rib_size(
                &cfg(&[("enable_prime_tower", serde_json::json!(true))]),
                2,
                &[vec![1, 2]],
                &|_| 0.2,
                0
            )
            .is_none()
        );
    }

    #[test]
    fn a_tower_without_purge_in_prime_tower_is_sized_by_the_prime_volume() {
        // Eight filaments, every layer printing all of them at 0.08 mm, flushes up to 715 mm3: Orca
        // (`Print::_make_wipe_tower`) puts only `prime_volume` on the tower when `purge_in_prime_tower`
        // is off or on a Bambu Lab printer, so the tower must not be sized from the matrix.
        let matrix: Vec<u32> = (0..64)
            .map(|i| if i % 9 == 0 { 0 } else { 300 + (i * 37) % 420 })
            .collect();
        let order: Vec<Vec<u8>> = (0..50)
            .map(|l| {
                if l % 2 == 0 {
                    (1..=8).collect()
                } else {
                    (1..=8).rev().collect()
                }
            })
            .collect();
        let sized = |c: &PrintConfig| plan_rows(c, 35.0, 8, &order, &|_| 0.08, order.len() - 1);
        let flush = ("flush_volumes_matrix", serde_json::json!(matrix));
        let off = cfg(&[
            flush.clone(),
            ("purge_in_prime_tower", serde_json::json!(false)),
            ("prime_volume", serde_json::json!(45)),
        ]);
        let plain = cfg(&[
            ("purge_in_prime_tower", serde_json::json!(false)),
            ("prime_volume", serde_json::json!(45)),
        ]);
        assert!(
            (sized(&off) - sized(&plain)).abs() < 1e-9,
            "{} rows against {}",
            sized(&off),
            sized(&plain)
        );
        let on = cfg(&[flush.clone(), ("prime_volume", serde_json::json!(45))]);
        assert!(sized(&on) > 5.0 * sized(&off));
        // It fits beside the part, on a type 2 tower and on a Bambu Lab square one.
        let parts = [part(80.0, 80.0, 180.0, 170.0)];
        for extra in [
            vec![],
            vec![("printer_model", serde_json::json!("Bambu Lab P1S"))],
        ] {
            let mut pairs = vec![
                flush.clone(),
                ("purge_in_prime_tower", serde_json::json!(false)),
                ("prime_tower_auto_position", serde_json::json!(true)),
            ];
            pairs.extend(extra);
            let c = tower_cfg(&pairs);
            let rows = |w: f64| plan_rows(&c, w, 8, &order, &|_| 0.08, order.len() - 1);
            let Ok(Some(p)) = place(&c, 8, &rows, None, &parts, 80.0) else {
                panic!("placed")
            };
            let Some(t) = p.tower(&c, 8) else { panic!("tower") };
            assert!(t.depth < 150.0, "{:.0} mm deep", t.depth);
        }
    }

    #[test]
    fn purge_rows_speed_up_and_the_free_depth_gets_a_grid() {
        // A P1S tower 50 mm wide, 40 rows deep, where the layer purged 10 rows.
        let c = cfg(&[
            ("enable_prime_tower", serde_json::json!(true)),
            ("printer_model", serde_json::json!("Bambu Lab P1S")),
        ]);
        let Some(t) = Tower::new(&c, 2, 40.0).map(|t| t.shaped(50.0, 0.0).at([0.0, 0.0])) else {
            panic!("tower")
        };
        let (rows, n) = t.purge(45.0, 0.2, false, 0.0);
        let count = |v: usize| f64::from(u32::try_from(v).unwrap_or(u32::MAX));
        assert!((count(rows.len()) - n).abs() < 1e-9);
        let speeds: Vec<f32> = rows.iter().map(|r| r.speed_mm_s).collect();
        for (got, want) in speeds.iter().zip([26.4, 30.0, 36.64, 70.0, 70.0 + 50.0 / 60.0]) {
            assert!((f64::from(*got) - want).abs() < 1e-3, "{speeds:?}");
        }
        // Each row ends where the next begins, so the rows print as one zigzag.
        for pair in rows.windows(2) {
            assert_eq!(pair[0].points.last(), pair[1].points.first());
        }
        let fill = t.fill(&c, 10.0, false);
        // The outline of the free box, the left leg of the inverse U and lines about 10 mm apart.
        let inner = t.width - 7.0 * t.wall_w;
        assert!(
            (count(fill.len()) - (3.0 + (inner / 10.0).floor())).abs() < 1e-9,
            "{} paths",
            fill.len()
        );
        let y0 = 2.0 * t.wall_w + 10.0 * t.spacing;
        for p in fill.iter().flat_map(|f| &f.points) {
            let (x, y) = (p.x_mm(), p.y_mm());
            assert!(x > 0.0 && x < t.width && y >= y0 - 1e-6 && y < t.depth, "{x} {y}");
        }
        // Nothing to fill when the purges take the whole depth.
        assert!(t.fill(&c, 40.0, false).is_empty());
    }

    #[test]
    fn a_bambu_tower_takes_only_the_prime_volume() {
        let matrix = ("flush_volumes_matrix", serde_json::json!([0, 280, 280, 0]));
        let bambu = cfg(&[
            matrix.clone(),
            ("printer_model", serde_json::json!("Bambu Lab P1S")),
            ("prime_volume", serde_json::json!(45)),
        ]);
        assert!((purge_volume(&bambu, 2, 1, 2) - 45.0).abs() < 1e-9);
        // A multi-tool printer (no shared nozzle) primes only too; a shared nozzle purges the flush.
        let tools = cfg(&[
            matrix.clone(),
            ("single_extruder_multi_material", serde_json::json!(0)),
        ]);
        assert!((purge_volume(&tools, 2, 1, 2) - 45.0 * PURGE_EXTRA).abs() < 1e-9);
        let semm = cfg(&[matrix]);
        assert!((purge_volume(&semm, 2, 1, 2) - 280.0 * PURGE_EXTRA).abs() < 1e-9);
    }

    #[test]
    fn one_nozzle_reads_its_matrix_by_filament() {
        let c = cfg(&[("flush_volumes_matrix", serde_json::json!([0, 120, 200, 0]))]);
        assert_eq!(flush_entry(&c, 2, 0, 1), Some(120.0));
        assert_eq!(flush_entry(&c, 2, 1, 0), Some(200.0));
        assert_eq!(flush_entry(&c, 2, 2, 0), None);
    }

    #[test]
    fn a_dual_nozzle_printer_reads_the_block_of_the_new_filaments_nozzle() {
        // H2D style: two filaments, two nozzles, one 2 by 2 block per nozzle. Filament 1 prints on
        // the left nozzle (extruder 2 in Orca's numbering), filament 2 on the right one (extruder 1).
        let c = cfg(&[
            ("nozzle_diameter", serde_json::json!([0.4, 0.4])),
            ("filament_map", serde_json::json!([2, 1])),
            (
                "flush_volumes_matrix",
                serde_json::json!([0, 111, 222, 0, 0, 333, 444, 0]),
            ),
        ]);
        // To filament 2 (block of nozzle 1): row 0, column 1.
        assert_eq!(flush_entry(&c, 2, 0, 1), Some(111.0));
        // To filament 1 (block of nozzle 2): row 1, column 0.
        assert_eq!(flush_entry(&c, 2, 1, 0), Some(444.0));
        // A matrix for more filaments than the plate uses is still read by its own side.
        let wide = cfg(&[(
            "flush_volumes_matrix",
            serde_json::json!([0, 1, 2, 3, 0, 5, 6, 7, 0]),
        )]);
        assert_eq!(flush_entry(&wide, 2, 1, 0), Some(3.0));
        assert!((purge_volume(&wide, 2, 2, 1) - 3.0 * PURGE_EXTRA).abs() < 1e-9);
    }
}
