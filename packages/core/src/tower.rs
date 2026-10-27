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
    /// The first row of the new filament's wipe after a tool change, where the nozzle wipes its start blob off
    /// (`prime_tower_skip_points`): the writer prints 3 mm of the row, retracts, travels back over the row's start
    /// and forward again slowly, primes and finishes the row.
    pub(crate) nozzle_wipe: bool,
    /// A piece of the wall that the nozzle reaches by hopping the opening before it (`prime_tower_skip_points`):
    /// retracted, at 10 mm/s.
    pub(crate) hop: bool,
    /// What an old filament rams out before a change, which runs past the filament's volumetric limit.
    pub(crate) ram: bool,
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
    /// A purge row's volume per mm over the wall bead's: `wipe_tower_extra_flow` on a type 2 tower, 1 on type 1.
    row_flow: f64,
    /// Distance between purge rows at full density, mm.
    spacing: f64,
    /// Rotation about the front left corner, degrees (`wipe_tower_rotation_angle`).
    angle: f64,
    /// Brim around the first layer, mm (`prime_tower_brim_width`; negative sizes it by the
    /// tower's height).
    brim: f64,
    /// Speeds, mm/s: the first layer, the walls and the purge rows above it.
    first_speed: f64,
    /// The type 1 tower's speed cap and the target its wipe rows speed up to, mm/s (`prime_tower_max_speed`, 90
    /// when the settings leave it out); its first layer takes the lower of it and `initial_layer_speed`.
    max_speed: f64,
    wall_speed: f64,
    purge_speed: f64,
    /// Orca's type 1 (Bambu Lab) tower.
    type1: bool,
    /// The purge prints whole rows (type 1, and `PrusaSlicer`'s wipe, which fills the rows it planned; also a single
    /// nozzle's flush on a type 2 tower).
    whole_rows: bool,
    /// Each wipe after a tool change starts with a short nozzle wipe (`prime_tower_skip_points` on a type 1 tower).
    skip_points: bool,
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

/// The speed a type 1 tower's contact wipe ([`Tower::purge_lead`]) speeds up to, mm/s.
const CONTACT_WIPE_SPEED: f64 = 20.0;

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
        // A type 1 tower wipes the new filament's own prime volume; type 2 wipes `prime_volume` and runs about a
        // tenth over.
        if type1(cfg) {
            return prime_volume_of(cfg, to);
        }
        return cfg.raw_number("prime_volume", 45.0) * PURGE_EXTRA;
    }
    let mult = cfg.raw_number("flush_multiplier", 1.0).max(0.0);
    let floor = per_slot_raw(cfg, "filament_minimal_purge_on_wipe_tower", to, 15.0).max(0.0);
    match flush_entry(
        cfg,
        tools,
        usize::from(from.max(1) - 1),
        usize::from(to.max(1) - 1),
    ) {
        // A flush never purges less than the new filament's `filament_minimal_purge_on_wipe_tower`.
        Some(v) if v > 0.0 => (v * mult).max(floor),
        // A zero entry asks for no flush, so the change purges the floor alone.
        Some(_) => floor,
        _ => cfg.raw_number("prime_volume", 45.0).max(floor),
    }
}

/// What the tower purges of a change into slot `to` (1-based) after the new filament's infill, objects or support
/// took up `taken` mm3 of its `wipe`. With the flush on the tower the rest never drops below the new filament's
/// `filament_minimal_purge_on_wipe_tower`: what the objects take comes on top of the floor. Elsewhere the tower
/// purges what is left.
pub(crate) fn tower_share(cfg: &PrintConfig, to: u8, wipe: f64, taken: f64) -> f64 {
    if !flush_on_tower(cfg) {
        return wipe - taken;
    }
    let floor = per_slot_raw(cfg, "filament_minimal_purge_on_wipe_tower", to, 15.0).max(0.0);
    (wipe - taken).max(floor)
}

/// The prime volume a filament gets when the settings list none for it, mm3.
pub(crate) const DEFAULT_PRIME: f64 = 45.0;

/// What each change wipes with `prime_volume_mode` Saving, mm3.
const SAVING_PRIME: f64 = 15.0;

/// `prime_volume_mode` Saving: every change wipes [`SAVING_PRIME`].
fn saving_mode(cfg: &PrintConfig) -> bool {
    cfg.raw.get("prime_volume_mode").and_then(|v| v.as_str()) == Some("Saving")
}

/// What a type 1 tower wipes after a change into filament `slot` (1-based), mm3: the filament's own
/// `filament_prime_volume`, at least 1, or [`DEFAULT_PRIME`] when the list has no value for it (the key is absent or
/// the list is shorter than the filaments). A listed value always wins. `prime_volume` is not read here.
pub(crate) fn prime_volume_of(cfg: &PrintConfig, slot: u8) -> f64 {
    if saving_mode(cfg) {
        return SAVING_PRIME;
    }
    listed(cfg, "filament_prime_volume", slot).map_or(DEFAULT_PRIME, |v| v.max(1.0))
}

/// The number a per-filament setting lists for filament `slot` (1-based): its entry in the list, or the one value
/// of a setting that is not a list. None when the list stops short of the filament or the setting is absent.
pub(crate) fn listed(cfg: &PrintConfig, key: &str, slot: u8) -> Option<f64> {
    let num = |v: &serde_json::Value| match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    };
    match cfg.raw.get(key)? {
        serde_json::Value::Array(a) => a.get(usize::from(slot.max(1) - 1)).and_then(num),
        v => num(v),
    }
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
    /// A single nozzle's ramming lines ([`RamLine`]), from the old filament's `filament_ramming_parameters`; None
    /// for any other ramming.
    pub(crate) ram_line: Option<RamLine>,
}

/// The lines a single nozzle for several filaments rams the old filament out in: `width` = the first ramming token
/// percent of the tower's wall bead, `pitch` = the width times the second token percent and
/// `wipe_tower_extra_spacing`, mm.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct RamLine {
    pub(crate) width: f64,
    pub(crate) pitch: f64,
}

/// The tower's share of a change from slot `from` to slot `to` (1-based):
///
/// - Two extruders with a filament map (H2D, H2C; Bambu Studio's `Print::_make_wipe_tower` and
///   `WipeTower::plan_toolchange`): the new filament primes `filament_prime_volume` ([`prime_volume_of`]), or
///   `filament_prime_volume_nc` (60 when unlisted) after a hotend swap on the rack, and when the nozzle changes the old one
///   first rams out `filament_change_length` (`filament_change_length_nc` for a hotend swap) mm of filament.
///   The flush itself goes to the chute, and only when the nozzle held another filament.
/// - A Prusa tool changer (the XL; `PrusaSlicer`'s `WipeTower::extract_wipe_volumes`): each head that
///   already holds its filament wipes `filament_minimal_purge_on_wipe_tower`, after the old head rams
///   `filament_multitool_ramming_volume` when `filament_multitool_ramming` is on.
/// - Any other tool changer (the Snapmaker U1; Orca's `WipeTower2`): `prime_volume`, plus the multitool
///   ramming when the filament asks for it.
/// - One nozzle: [`purge_volume`] (on a type 1 tower the new filament's [`prime_volume_of`]).
pub(crate) fn change_purge(cfg: &PrintConfig, tools: u8, from: u8, to: u8) -> ChangePurge {
    // The ramming length is the outgoing filament's.
    let area = cfg.filament_area(from);
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
        let wipe = if saving_mode(cfg) {
            SAVING_PRIME
        } else if nozzle_change {
            listed(cfg, "filament_prime_volume_nc", to)
                .unwrap_or(60.0)
                .max(1.0)
        } else {
            prime_volume_of(cfg, to)
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
            ram_line: None,
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
            ram_line: None,
        };
    }
    let (ram, ram_line) = match shared_ramming(cfg, from) {
        Some((volume, line)) => (volume, Some(line)),
        None => (ram, None),
    };
    ChangePurge {
        wipe: purge_volume(cfg, tools, from, to),
        ram,
        nozzle_change: false,
        ram_line,
    }
}

/// What a single nozzle for several filaments on a type 2 tower rams out of filament `from` (1-based) before a
/// change, with `enable_filament_ramming` on: 0.25 s at each speed (mm3/s) its `filament_ramming_parameters` list
/// after the first two tokens, mm3, and the lines it is laid in. None when ramming is off or lists no speed.
/// `purge_in_prime_tower` does not change it.
fn shared_ramming(cfg: &PrintConfig, from: u8) -> Option<(f64, RamLine)> {
    if type1(cfg)
        || !flag_or(cfg, "single_extruder_multi_material", true)
        || !flag_or(cfg, "enable_filament_ramming", true)
    {
        return None;
    }
    let tokens = ramming_tokens(cfg, from)?;
    let volume: f64 = tokens.speeds.iter().map(|s| RAM_STEP * s.max(0.0)).sum();
    if volume <= 0.0 || tokens.width <= 0.0 || tokens.pitch <= 0.0 {
        return None;
    }
    let wall_w = cfg.nozzle_diameter * 1.25;
    let extra_spacing = (cfg.raw_number("wipe_tower_extra_spacing", 100.0) / 100.0).clamp(0.5, 5.0);
    let width = tokens.width / 100.0 * wall_w;
    Some((
        volume,
        RamLine {
            width,
            pitch: width * tokens.pitch / 100.0 * extra_spacing,
        },
    ))
}

/// True where the ramming before a change is a single nozzle's ([`shared_ramming`]), which runs at the speeds its
/// filament lists, past the volumetric limit.
pub(crate) fn rams_past_cap(cfg: &PrintConfig) -> bool {
    !type1(cfg) && flag_or(cfg, "single_extruder_multi_material", true)
}

/// How long a single nozzle rams at each speed its `filament_ramming_parameters` lists, s.
pub(crate) const RAM_STEP: f64 = 0.25;

/// A tool changer's type 2 tower, where each layer's first purge gives way to what finishing the layer
/// extrudes anyway (Orca's and `PrusaSlicer`'s `save_on_last_wipe`). A single nozzle keeps its purge.
pub(crate) fn saves_on_last_wipe(cfg: &PrintConfig) -> bool {
    !type1(cfg) && !flag_or(cfg, "single_extruder_multi_material", true)
}

/// A type 2 tower whose layer's first purge gives way to what finishing the layer extrudes anyway: a tool changer's
/// ([`saves_on_last_wipe`]) and a single nozzle's whose flush goes on the tower.
pub(crate) fn saves_first_purge(cfg: &PrintConfig) -> bool {
    saves_on_last_wipe(cfg) || flush_on_tower(cfg)
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

    /// The report entry for `t`, the tower as it prints (this placement's, with its rib wall): corner, size,
    /// reason and the box it prints in, with a first layer `first_h` mm high and `height` mm to its top, mm.
    pub(crate) fn report(&self, t: &Tower, first_h: f64, height: f64) -> crate::output::TowerPlacement {
        crate::output::TowerPlacement {
            x: self.origin[0],
            y: self.origin[1],
            width: t.width,
            depth: t.depth,
            angle: t.angle,
            reason: self.reason,
            footprint: t.footprint(first_h, height),
        }
    }
}

/// How far an object's first layer reaches past its hull with `cfg`, mm: its brim, or its support's first layer
/// (the pad `raft_first_layer_expansion` and `support_expansion` widen, a tree's brim and half a branch, and for
/// grid supports the cell the islands are stretched to), whichever is wider, and with a skirt of its own
/// (`skirt_type` per object) the skirt's loops round that.
pub(crate) fn room(cfg: &PrintConfig) -> f64 {
    room_with(cfg, cfg.brim_width)
}

/// [`room`] for a brim that reaches `brim` mm past the first layer (an automatic brim, sized per object).
pub(crate) fn room_with(cfg: &PrintConfig, brim: f64) -> f64 {
    let brim = brim.max(0.0);
    let support = if cfg.enable_support {
        let s = &cfg.support;
        let line = cfg.support_width().max(0.0);
        let pad = s.expansion.max(0.0) + cfg.raw_number("raft_first_layer_expansion", 2.0).max(0.0);
        if s.style.is_tree() || s.tree {
            pad + s.tree_settings.brim_width.max(0.0) + 0.5 * s.tree_settings.branch_diameter.max(0.0) + line
        } else if matches!(
            s.style,
            crate::config::SupportStyle::Default | crate::config::SupportStyle::Grid
        ) {
            grid_reach(cfg, line, pad)
        } else {
            pad + line
        }
    } else {
        0.0
    };
    let under = brim.max(support);
    let own = matches!(cfg.raw.get("skirt_type"), Some(serde_json::Value::String(t)) if t == "perobject");
    if !own || cfg.skirt_loops == 0 || cfg.skirt_height == 0 {
        return under;
    }
    under + cfg.skirt_distance.max(0.0) + f64::from(cfg.skirt_loops) * crate::session::skirt_spacing_mm(cfg)
}

/// How far grid style support's first layer can print past the overhang it holds up, mm. The islands are
/// stretched to whole cells of the grid (a cell is `support_base_pattern_spacing` plus the line spacing, so an
/// island that just reaches into a cell fills all of it), printed half a line spacing past the cells, and the
/// first layer grows by `pad` (`raft_first_layer_expansion` and `support_expansion`) round that. The grid is
/// turned by `support_angle`, and its corners with it, so measured along the plate's axes all of it reaches up
/// to |cos| + |sin| of the angle as far. On a plate of mushroom-shaped parts the first layer pad reached 4.9 mm
/// past the caps where the old estimate, the pad and one line, gave 2.45; with the grid at 30 degrees one part's
/// pad reached 6.75 mm. `line` is the support line width.
fn grid_reach(cfg: &PrintConfig, line: f64, pad: f64) -> f64 {
    let h = cfg.initial_layer_print_height.min(cfg.layer_height).max(0.01);
    let spacing = (line - h * (1.0 - std::f64::consts::FRAC_PI_4)).max(0.0);
    let cell = spacing + cfg.support.base_spacing.max(0.0);
    let turn = cfg.support.angle.to_radians();
    (cell + 0.5 * spacing + pad) * (turn.m_cos().abs() + turn.m_sin().abs()) + 0.01
}

/// Boxes `[min x, min y, max x, max y]` the tower must stay out of besides the objects: every
/// keep-out zone (`bed_exclude_area`, with Bambu's cutter and purge corner, and the nozzle wrap check corner) and the purge line the
/// start G-code draws on the bed (its extruding moves below 1 mm, as literal coordinates).
fn no_go(cfg: &PrintConfig) -> Vec<[f64; 4]> {
    let bbox = |pts: &[[f64; 2]]| {
        pts.iter().fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| {
            [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
        })
    };
    let mut out: Vec<[f64; 4]> = crate::preflight::keep_out_zones(cfg)
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
/// Clear means on the bed with a 1 mm margin, all the tower prints included (its first layer's brim or brim
/// chamfer to the outer edge of the last bead, a rib wall; `Tower::print_margin`), outside the printer's
/// no-go zones, 1 mm past everything an object's first layer lays down beyond its hull (`rooms`, one per
/// object: its brim, its support's pad and brim, a skirt of its own around them; `room`). A skirt round the whole plate
/// goes round the tower too, so its distance and loops also stay inside the bed. `None` when the tower is off or
/// not needed, an error when it fits nowhere. Every step is plain arithmetic in a fixed order, so
/// native and WASM pick the same spot.
pub(crate) fn place(
    cfg: &PrintConfig,
    tools: u8,
    rows_at: &dyn Fn(f64) -> f64,
    rib: Option<(f64, f64)>,
    objects: &[crate::output::ObjectFootprint],
    rooms: &[f64],
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
    // the plate skirt wraps the tower's brim as well as the objects.
    let shield =
        matches!(cfg.raw.get("draft_shield"), Some(serde_json::Value::String(value)) if value == "enabled");
    let edge = if cfg.skirt_loops > 0 && (cfg.skirt_height > 0 || shield) {
        1.0 + cfg.skirt_distance.max(0.0) + f64::from(cfg.skirt_loops) * crate::session::skirt_spacing_mm(cfg)
    } else {
        1.0
    };
    let bed = cfg.bed_rect();
    let hull_box = |o: &crate::output::ObjectFootprint| {
        o.hull
            .iter()
            .fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| {
                [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
            })
    };
    let mut boxes: Vec<[f64; 4]> = Vec::with_capacity(objects.len());
    for (k, o) in objects.iter().enumerate() {
        let b = hull_box(o);
        let pad = rooms.get(k).copied().unwrap_or_else(|| room(cfg)) + 1.0;
        boxes.push([b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]);
    }
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
            let r = t.reach(t.print_margin(cfg.initial_layer_print_height, height));
            let clear = |x: f64, y: f64| {
                let (lx, ly, hx, hy) = (x + r[0], y + r[1], x + r[2], y + r[3]);
                lx >= bed[0] + edge
                    && ly >= bed[1] + edge
                    && hx <= bed[2] - edge
                    && hy <= bed[3] - edge
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
                    inside(t0.x, bed[0] + edge - r[0], bed[2] - edge - r[2]),
                    inside(t0.y, bed[1] + edge - r[1], bed[3] - edge - r[3]),
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
            let x0 = (bed[0] + edge - r[0]).ceil();
            let y0 = (bed[1] + edge - r[1]).ceil();
            let mut y = y0;
            while y + r[3] <= bed[3] - edge {
                let mut x = x0;
                while x + r[2] <= bed[2] - edge {
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

    /// True for a type 1 (Bambu Lab) tower.
    pub(crate) fn is_type1(&self) -> bool {
        self.type1
    }

    /// Rotation about the front left corner, degrees.
    pub(crate) fn angle(&self) -> f64 {
        self.angle
    }

    /// The front left corner, mm.
    pub(crate) fn origin(&self) -> [f64; 2] {
        [self.x, self.y]
    }

    /// A purge row's volume per mm at height `h`, mm2: the wall bead's times [`Self::row_flow`].
    fn row_area(&self, h: f64) -> f64 {
        self.row_flow * bead(self.wall_w, h)
    }

    /// The same tower with another width and rotation (its depth stays the rows it was made for).
    pub(crate) fn shaped(mut self, width: f64, angle: f64) -> Self {
        self.width = width.max(5.0);
        self.angle = angle;
        self
    }

    /// The box of the tower's first layer on the plate, its brim included, as four corners in mm: what the skirt goes
    /// round (Orca's `first_layer_wipe_tower_corners`).
    pub(crate) fn first_layer_corners(&self) -> [[f64; 2]; 4] {
        let r = self.reach(self.brim.max(0.0));
        let (x, y) = (self.x, self.y);
        [
            [x + r[0], y + r[1]],
            [x + r[2], y + r[1]],
            [x + r[2], y + r[3]],
            [x + r[0], y + r[3]],
        ]
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
            (wall_w * extra_flow, wall_w * extra_flow * extra_spacing)
        };
        let width = cfg.raw_number("prime_tower_width", 35.0).max(5.0);
        let rows = rows.max(1.0);
        let max_purge = cfg.raw_number("wipe_tower_max_purge_speed", 90.0).max(1.0);
        let first_layer = if cfg.initial_layer_speed > 0.0 {
            cfg.initial_layer_speed
        } else {
            30.0
        };
        let positive = |v: f64| if v > 0.0 { v } else { 80.0 };
        // A type 1 tower caps everything it prints, wipe rows, wall and fill, by `prime_tower_max_speed`.
        let max_speed = positive(cfg.raw_number("prime_tower_max_speed", 90.0));
        let first_speed = if type1(cfg) {
            first_layer.min(max_speed)
        } else {
            first_layer
        };
        Some(Self {
            x: cfg.raw_number("wipe_tower_x", 15.0),
            y: cfg.raw_number("wipe_tower_y", 220.0),
            width,
            depth: rows * spacing + 2.0 * wall_w,
            wall_w,
            wipe_w,
            row_flow: if type1(cfg) { 1.0 } else { extra_flow },
            spacing,
            angle: cfg.raw_number("wipe_tower_rotation_angle", 0.0),
            brim: cfg.raw_number("prime_tower_brim_width", 3.0),
            first_speed,
            max_speed,
            wall_speed: if type1(cfg) {
                max_speed
            } else {
                max_purge.min(positive(cfg.inner_wall_speed))
            },
            // PrusaSlicer wipes at the infill speed with no cap of its own (`WipeTower::toolchange_Wipe`).
            purge_speed: if prusa_tools(cfg) {
                positive(cfg.sparse_infill_speed)
            } else {
                max_purge.min(positive(cfg.sparse_infill_speed))
            },
            type1: type1(cfg),
            whole_rows: type1(cfg) || prusa_tools(cfg) || flush_on_tower(cfg),
            skip_points: type1(cfg) && flag_or(cfg, "prime_tower_skip_points", true),
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
            nozzle_wipe: false,
            hop: false,
            ram: false,
        }
    }

    /// Where the first row of a wipe from row `start` begins, in the tower's own frame: the wipe's nozzle wipe
    /// starts there, and the wall opens level with it.
    pub(crate) fn row_start(&self, start: f64) -> (f64, f64) {
        let edge = if self.type1 {
            self.wall_w
        } else {
            2.0 * self.wall_w
        };
        (edge, 2.0 * self.wall_w + start * self.spacing)
    }

    /// The wall loop at height `z` with an opening level with each wipe start in `starts` (the tower's own frame),
    /// when `prime_tower_skip_points` is on a type 1 tower: from the start, straight out to the nearer side, the
    /// opening is centered where that line meets the wall and runs 2.5 beads along the wall each way; openings that
    /// overlap merge. The wall prints as the pieces between them, from the piece that starts nearest the loop's own
    /// start, and the nozzle hops each opening it meets on the way round. Without openings, [`Self::wall`].
    pub(crate) fn wall_pieces(&self, first: bool, z: f64, starts: &[(f64, f64)]) -> Vec<TowerPath> {
        let whole = self.wall(first, z);
        if !self.skip_points || starts.is_empty() {
            return vec![whole];
        }
        let h = self.wall_w / 2.0;
        let mut ring: Vec<(f64, f64)> = if self.rib.is_some() {
            self.wall_polygon(z)
        } else {
            vec![
                (h, h),
                (self.width - h, h),
                (self.width - h, self.depth - h),
                (h, self.depth - h),
            ]
        };
        let Some(&first_pt) = ring.first() else {
            return vec![whole];
        };
        ring.push(first_pt);
        let seg = |a: (f64, f64), b: (f64, f64)| (b.0 - a.0).m_hypot(b.1 - a.1);
        let mut along = vec![0.0];
        for w in ring.windows(2) {
            if let [a, b] = w {
                along.push(along.last().copied().unwrap_or(0.0) + seg(*a, *b));
            }
        }
        let perimeter = along.last().copied().unwrap_or(0.0);
        let half = 2.5 * self.wall_w;
        if perimeter <= 4.0 * half {
            return vec![whole];
        }
        // Each opening as its start along the loop and its length.
        let mut gaps: Vec<(f64, f64)> = starts
            .iter()
            .filter_map(|&(sx, sy)| {
                let left = sx < self.width / 2.0;
                let mut best: Option<(f64, f64)> = None;
                for (i, w) in ring.windows(2).enumerate() {
                    let [a, b] = w else { continue };
                    if (a.1 - sy) * (b.1 - sy) > 0.0 || (b.1 - a.1).abs() < 1e-12 {
                        continue;
                    }
                    let t = (sy - a.1) / (b.1 - a.1);
                    let x = a.0 + t * (b.0 - a.0);
                    let out = if left { sx - x } else { x - sx };
                    if out < -1e-9 {
                        continue;
                    }
                    let at = along.get(i).copied().unwrap_or(0.0) + t * seg(*a, *b);
                    if best.is_none_or(|(d, _)| out < d) {
                        best = Some((out, at));
                    }
                }
                best.map(|(_, at)| ((at - half).rem_euclid(perimeter), 2.0 * half))
            })
            .collect();
        if gaps.is_empty() {
            return vec![whole];
        }
        gaps.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut merged: Vec<(f64, f64)> = Vec::new();
        for (a, len) in gaps {
            match merged.last_mut() {
                Some(m) if a <= m.0 + m.1 + 1e-9 => m.1 = m.1.max(a + len - m.0),
                _ => merged.push((a, len)),
            }
        }
        // The last opening may run past the loop's start into the first one.
        if merged.len() > 1
            && let (Some(&last), Some(&head)) = (merged.last(), merged.first())
            && last.0 + last.1 - perimeter >= head.0 - 1e-9
        {
            merged.pop();
            if let Some(f) = merged.first_mut() {
                let end = (last.0 + last.1 - perimeter).max(f.0 + f.1);
                *f = (last.0 - perimeter, end - (last.0 - perimeter));
            }
        }
        if merged.iter().map(|g| g.1).sum::<f64>() >= perimeter - 1e-6 {
            return vec![whole];
        }
        let point_at = |d: f64| -> (f64, f64) {
            let d = d.rem_euclid(perimeter);
            let i = along.partition_point(|&v| v <= d).saturating_sub(1);
            match (ring.get(i), ring.get(i + 1), along.get(i), along.get(i + 1)) {
                (Some(&a), Some(&b), Some(&da), Some(&db)) if db > da => {
                    let t = (d - da) / (db - da);
                    (a.0 + t * (b.0 - a.0), a.1 + t * (b.1 - a.1))
                }
                (Some(&a), ..) => a,
                _ => first_pt,
            }
        };
        // The pieces between the openings, along the loop.
        let n = merged.len();
        let pieces: Vec<Vec<(f64, f64)>> = (0..n)
            .filter_map(|k| {
                let g = merged.get(k)?;
                let next = merged.get((k + 1) % n)?;
                let from = g.0 + g.1;
                let mut to = next.0;
                while to <= from {
                    to += perimeter;
                }
                let mut pts = vec![point_at(from)];
                // the loop's corners inside the piece, over one or two laps of the loop
                for lap in [-perimeter, 0.0, perimeter, 2.0 * perimeter] {
                    for (i, &d) in along.iter().enumerate().take(ring.len() - 1) {
                        let d = d + lap;
                        if d > from + 1e-9
                            && d < to - 1e-9
                            && let Some(&q) = ring.get(i)
                        {
                            pts.push(q);
                        }
                    }
                }
                pts.push(point_at(to));
                Some(pts)
            })
            .collect();
        let first_piece = pieces
            .iter()
            .enumerate()
            .min_by(|a, b| {
                let d = |p: &Vec<(f64, f64)>| p.first().map_or(f64::MAX, |&q| seg(q, first_pt));
                d(a.1).total_cmp(&d(b.1))
            })
            .map_or(0, |(k, _)| k);
        (0..n)
            .filter_map(|j| pieces.get((first_piece + j) % n).map(|p| (j, p)))
            .map(|(j, p)| TowerPath {
                points: p.iter().map(|&(x, y)| self.place_point(x, y)).collect(),
                hop: j > 0,
                ..whole.clone()
            })
            .collect()
    }

    /// What fills the depth a layer's purges leave free, so the purges of the layers above have
    /// something to stand on (Orca: `WipeTower::finish_block` and `finish_layer_new`, `WipeTower2::
    /// finish_layer`): an outline round the free box, then on the first layer solid rows, and above
    /// it an inverse U with lines across the box about `wipe_tower_bridging` apart (10 mm on a type
    /// 1 tower). `used_rows` is how many purge rows the layer printed. Empty when no room is left.
    pub(crate) fn fill(&self, cfg: &PrintConfig, used_rows: f64, first: bool) -> Vec<TowerPath> {
        self.fill_range(cfg, used_rows, None, first)
    }

    /// [`Self::fill`] of the depth from row `used_rows` up to row `to` (a block of the tower that ends before the
    /// tower does), or to the tower's back with `to` None.
    pub(crate) fn fill_range(
        &self,
        cfg: &PrintConfig,
        used_rows: f64,
        to: Option<f64>,
        first: bool,
    ) -> Vec<TowerPath> {
        let w = self.wall_w;
        let (x0, x1) = (1.5 * w, self.width - 1.5 * w);
        let y0 = if used_rows > 0.0 {
            2.0 * w + used_rows * self.spacing
        } else {
            1.5 * w
        };
        let y1 = to.map_or(self.depth - 1.5 * w, |r| r * self.spacing + 0.5 * w);
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
            nozzle_wipe: false,
            hop: false,
            ram: false,
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
                nozzle_wipe: false,
                hop: false,
                ram: false,
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
                    nozzle_wipe: false,
                    hop: false,
                    ram: false,
                }
            })
            .collect()
    }

    /// How far past its box (with a rib wall, the box round the ribs) the tower's first layer prints, to the outer
    /// edge of the outermost bead, mm, with a first layer `first_h` mm high and `height` mm to the top (which sizes a
    /// negative brim). That layer prints the most: the brim (or brim chamfer) only narrows above it. A brim's
    /// loops run inside its width from the box (`brim`); a type 1 tower's chamfer loops go round its wall, one
    /// spacing apart, so the last bead reaches half a bead past them (`chamfer`). A rib wall runs on the box.
    pub(crate) fn print_margin(&self, first_h: f64, height: f64) -> f64 {
        let width = if self.brim < 0.0 {
            (height / 100.0).min(1.0) * 8.0
        } else {
            self.brim
        };
        let spacing = self.wall_w - first_h * (1.0 - std::f64::consts::FRAC_PI_4);
        let loops = if width > 0.0 && spacing > 0.0 {
            ((width + spacing / 2.0) / spacing).floor().max(0.0)
        } else {
            0.0
        };
        let wall = if self.rib.is_some() {
            self.wall_w / 2.0
        } else {
            0.0
        };
        if loops == 0.0 {
            wall
        } else if self.type1 {
            loops * spacing + self.wall_w / 2.0
        } else {
            (loops * spacing).max(wall)
        }
    }

    /// The plate box the tower prints in on every layer, `[min x, min y, max x, max y]` mm ([`Self::print_margin`]
    /// round its box, turned).
    pub(crate) fn footprint(&self, first_h: f64, height: f64) -> [f64; 4] {
        let r = self.reach(self.print_margin(first_h, height));
        [self.x + r[0], self.y + r[1], self.x + r[2], self.y + r[3]]
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
    /// it, then 50 mm/min more a row up to the target on a type 2 tower, where the target is the purge speed
    /// (the first layer's speed on the first layer). A type 1 tower's target is `prime_tower_max_speed` (on the
    /// first layer the lower of it and the first layer's speed), and from the fifth row on it holds 0.875 of it
    /// plus 50 mm/min.
    pub(crate) fn purge(&self, volume: f64, layer_h: f64, first: bool, start: f64) -> (Vec<TowerPath>, f64) {
        self.purge_lead(volume, layer_h, first, start, None, false)
    }

    /// [`Self::purge`] that first finishes the row a tool changer's ramming left off (`lead`: where the
    /// ramming ended across the tower and whether it was heading right), as Orca's and `PrusaSlicer`'s wipe
    /// takes the rest of the ramming's row (`first_wipe_line`) before its own rows.
    ///
    /// On a type 1 tower the first layer's wipe, and a `contact` wipe (the first change into a filament whose
    /// adhesion category comes back onto the tower), fill the same depth with rows one bead apart instead of
    /// `prime_tower_infill_gap` apart: as many as fit in it, at least one. A contact wipe has no nozzle wipe and
    /// speeds up to 20 mm/s, whatever the layer. The rows the wipe takes are its normal ones either way.
    pub(crate) fn purge_lead(
        &self,
        volume: f64,
        layer_h: f64,
        first: bool,
        start: f64,
        lead: Option<(f64, bool)>,
        contact: bool,
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
        let area = self.row_area(layer_h);
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
        let dense = self.type1 && (first || contact) && !lead_row && self.spacing > self.wall_w + 1e-9;
        let (printed, step) = if dense {
            (
                (n * self.spacing / self.wall_w + 1e-9).floor().max(1.0),
                self.wall_w,
            )
        } else {
            (n, self.spacing)
        };
        // The count is small (a purge is tens of rows).
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "row count is small"
        )]
        for _ in 0..(printed as usize) {
            let (a, b) = if left { (x0, x1) } else { (x1, x0) };
            pts.push((a, y));
            pts.push((b, y));
            y += step;
            left = !left;
        }
        // The last row is trimmed so the total matches the volume asked for.
        let full = n * row_len * self.row_area(layer_h);
        if !self.whole_rows && n > 0.0 && full > volume + 1e-9 && pts.len() >= 2 {
            let short = (full - volume) / self.row_area(layer_h);
            if let (Some(a), Some(b)) = (pts.get(pts.len() - 2).copied(), pts.last().copied()) {
                let len = (b.0 - a.0).abs();
                let keep = (len - short).max(0.0) / len.max(1e-9);
                if let Some(last) = pts.last_mut() {
                    last.0 = a.0 + (b.0 - a.0) * keep;
                }
            }
        }
        let target = if self.type1 {
            if contact {
                CONTACT_WIPE_SPEED
            } else if first {
                self.first_speed
            } else {
                self.max_speed
            }
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
                } else if self.type1 {
                    // A type 1 tower holds one speed from the fifth row on.
                    (0.875 * target + 50.0 / 60.0).min(target)
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
                flow: to_f32(area / bead(self.wipe_w, layer_h)),
                // A row a tool changer's ramming leads into is not the wipe's own start, and a contact wipe has none.
                nozzle_wipe: k == 0 && self.skip_points && !lead_row && !contact,
                hop: false,
                ram: false,
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
        if let Some(line) = p.ram_line {
            return self.shared_ramming(cfg, p.ram, line, from, layer_h, start);
        }
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
            nozzle_wipe: false,
            hop: false,
            ram: true,
        };
        (vec![path], rows, end.filter(|_| !p.nozzle_change))
    }
}

impl Tower {
    /// A single nozzle's ramming of `volume` mm3 of filament `from` before a change ([`shared_ramming`]): lines
    /// `line.width` wide and `line.pitch` apart from row `start`, centered from half a pitch into the change's
    /// band, each running between 1.5 wall beads in from the tower's sides and starting at the left one. Each
    /// speed the filament's `filament_ramming_parameters` lists lays [`RAM_STEP`] seconds of filament as its own
    /// pieces (split where a line turns) at that speed over the plain bead, past the volumetric limit; the last
    /// line stops at the volume, and the step to the next line is a travel. Returns the paths, the tower rows
    /// taken and where the last line stopped across the tower and whether it was heading right.
    fn shared_ramming(
        &self,
        cfg: &PrintConfig,
        volume: f64,
        line: RamLine,
        from: u8,
        layer_h: f64,
        start: f64,
    ) -> (Vec<TowerPath>, f64, Option<(f64, bool)>) {
        let (w, pitch) = (line.width, line.pitch);
        let inset = 1.5 * self.wall_w;
        let (x0, x1) = (inset, (self.width - inset).max(inset + 1.0));
        let row_len = x1 - x0;
        let area = bead(w, layer_h);
        let lines = ram_lines(volume, row_len, area);
        let speeds = ramming_tokens(cfg, from).map_or_else(Vec::new, |t| t.speeds);
        let mut y = 2.0 * self.wall_w + start * self.spacing + (pitch - self.spacing) / 2.0;
        let (mut x, mut right, mut line_no) = (x0, true, 1.0);
        let mut paths = Vec::new();
        for s in speeds.iter().copied().filter(|s| *s > 0.0) {
            let mut len = RAM_STEP * s / area;
            let speed = to_f32(s / area);
            while len > 1e-9 {
                let end = if right { x1 } else { x0 };
                let mut room = (end - x).abs();
                if room <= 1e-9 && line_no < lines {
                    // The line is full: a travel steps to the next one, which runs back the other way.
                    y += pitch;
                    right = !right;
                    line_no += 1.0;
                    room = row_len;
                }
                // The last line takes what is left, even a rounding past its end.
                let take = if line_no < lines { len.min(room) } else { len };
                let to = if right { x + take } else { x - take };
                paths.push(TowerPath {
                    points: vec![self.place_point(x, y), self.place_point(to, y)],
                    width_mm: to_f32(w),
                    speed_mm_s: speed,
                    flow: 1.0,
                    nozzle_wipe: false,
                    hop: false,
                    ram: true,
                });
                x = to;
                len -= take;
            }
        }
        let rows = (lines * pitch / self.spacing - 1e-9).ceil();
        (paths, rows, Some((x, right)))
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

impl Tower {
    /// The save of a layer's first purge of `volume` mm3 on a single nozzle whose flush goes on the tower
    /// ([`flush_on_tower`]): what the new filament `to` prints on the tower anyway after that change, the wall and
    /// the fill over the depth that none of the layer's purges uses, comes off it once, down to its
    /// `filament_minimal_purge_on_wipe_tower`. The purges are as first planned: `rows` rows, the whole of each
    /// purge with nothing saved. A first layer prints dense over everything a purge leaves, so there `rows` is
    /// where the purge starts and the fill is over all but the floor's rows from it.
    pub(crate) fn saved_first_wipe(
        &self,
        cfg: &PrintConfig,
        volume: f64,
        h: f64,
        first: bool,
        rows: f64,
        to: u8,
    ) -> f64 {
        let floor = per_slot_raw(cfg, "filament_minimal_purge_on_wipe_tower", to, 15.0).max(0.0);
        let wall = path_volume(&self.wall(first, 0.0), h);
        let from = if first {
            rows + self.purge(floor, h, first, rows).1
        } else {
            rows
        };
        let fill: f64 = self
            .fill(cfg, from, first)
            .iter()
            .map(|f| path_volume(f, h))
            .sum();
        floor.max(volume - wall - fill)
    }

    /// The rows a layer's purges take on this tower as first planned, the whole of each with nothing saved: the
    /// changes along `order` (the layer's filaments in print order) from filament `from`, at height `h`.
    pub(crate) fn planned_rows(
        &self,
        cfg: &PrintConfig,
        tools: u8,
        from: u8,
        order: &[u8],
        h: f64,
        first: bool,
    ) -> f64 {
        let (mut cur, mut rows) = (from, 0.0);
        for &t in order {
            if cur != 0 && t != cur {
                rows += self
                    .purge(change_purge(cfg, tools, cur, t).wipe, h, first, rows)
                    .1;
            }
            cur = t;
        }
        rows
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
        nozzle_wipe: false,
        hop: false,
        ram: false,
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
    if !saves_first_purge(cfg) {
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
    let row_flow = if type1(cfg) { 1.0 } else { extra_flow };
    let row_len = width.max(5.0) - 4.0 * wall_w;
    let mut cur = 0u8;
    // The most rows each block takes on any layer; the blocks stand side by side along the depth.
    let mut most: Vec<(i64, f64)> = Vec::new();
    for (l, order) in orders.iter().enumerate().take(top + 1) {
        let h = thickness(l);
        let mut rows = 0.0;
        let mut by_block: Vec<(i64, f64)> = Vec::new();
        let mut first_change = true;
        let planned = match saved {
            Some(t0) if flush_on_tower(cfg) => t0.planned_rows(cfg, tools, cur, order, h, l == 0),
            _ => 0.0,
        };
        for &t in order {
            if cur != 0 && t != cur {
                let p = change_purge(cfg, tools, cur, t);
                let mut v = p.wipe;
                if let Some(t0) = saved.filter(|_| first_change) {
                    v = if flush_on_tower(cfg) {
                        t0.saved_first_wipe(cfg, v, h, l == 0, if l == 0 { rows } else { planned }, t)
                    } else {
                        t0.saved_wipe(cfg, v, h, l == 0, rows, t)
                    };
                }
                first_change = false;
                let mut r = (v / (row_len * row_flow * bead(wall_w, h))).ceil().max(1.0);
                if p.ram > 0.0 {
                    r += ram_rows(cfg, p, width, h);
                }
                rows += r;
                add_to(&mut by_block, block_of(cfg, t), r);
            }
            cur = t;
        }
        for (b, r) in by_block {
            raise_to(&mut most, b, r);
        }
    }
    most.iter().map(|b| b.1).sum::<f64>().max(1.0)
}

/// Adds `v` to the entry of `key` in `list`.
fn add_to(list: &mut Vec<(i64, f64)>, key: i64, v: f64) {
    match list.iter_mut().find(|e| e.0 == key) {
        Some(e) => e.1 += v,
        None => list.push((key, v)),
    }
}

/// Raises the entry of `key` in `list` to at least `v`.
fn raise_to(list: &mut Vec<(i64, f64)>, key: i64, v: f64) {
    match list.iter_mut().find(|e| e.0 == key) {
        Some(e) => e.1 = e.1.max(v),
        None => list.push((key, v)),
    }
}

/// The block of a type 1 tower that a change into filament `slot` (1-based) wipes in: the filament's
/// `filament_adhesiveness_category`. Filaments of one category share a block; any other tower has one block.
pub(crate) fn block_of(cfg: &PrintConfig, slot: u8) -> i64 {
    if !type1(cfg) {
        return 0;
    }
    #[allow(clippy::cast_possible_truncation, reason = "a category number")]
    let c = per_slot_raw(cfg, "filament_adhesiveness_category", slot, 0.0).round() as i64;
    c
}

/// What a type 1 tower's layers print where, planned once for the print from the layers' filaments in print order
/// (`orders`, up to the tower's top layer `top`).
#[derive(Debug, Clone, Default)]
pub(crate) struct TowerPlan {
    /// The filament that prints the wall ([`wall_filament`]).
    pub(crate) wall: u8,
    /// The blocks along the depth, front first: an adhesion category and the rows it takes, the most any layer's
    /// changes into it take. The last block runs to the tower's back.
    pub(crate) blocks: Vec<(i64, f64)>,
    /// By layer, the categories that come onto the tower or leave it there (contact layers).
    pub(crate) contact: Vec<Vec<i64>>,
}

impl TowerPlan {
    /// The plan for `tower` as placed.
    pub(crate) fn new(
        cfg: &PrintConfig,
        tools: u8,
        orders: &[Vec<u8>],
        thickness: &dyn Fn(usize) -> f64,
        top: usize,
        tower: &Tower,
    ) -> Self {
        let mut blocks: Vec<(i64, f64)> = Vec::new();
        let row_len = (tower.width - 2.0 * tower.wall_w).max(1.0);
        // Each layer's categories on the tower: those of the filaments it changes from or to, or with no change
        // the one the nozzle holds.
        let mut presence: Vec<Vec<i64>> = Vec::new();
        let mut cur = 0u8;
        for (l, order) in orders.iter().enumerate().take(top + 1) {
            let h = thickness(l);
            let mut by_block: Vec<(i64, f64)> = Vec::new();
            let mut on: Vec<u8> = Vec::new();
            for &t in order {
                if cur != 0 && t != cur {
                    let p = change_purge(cfg, tools, cur, t);
                    let mut r = (p.wipe / (row_len * tower.row_area(h))).ceil().max(1.0);
                    if p.ram > 0.0 {
                        r += ram_rows(cfg, p, tower.width, h);
                    }
                    add_to(&mut by_block, block_of(cfg, t), r);
                    on.push(cur);
                    on.push(t);
                }
                cur = t;
            }
            if on.is_empty() && cur != 0 {
                on.push(cur);
            }
            let mut cats: Vec<i64> = on.iter().map(|&s| block_of(cfg, s)).collect();
            cats.sort_unstable();
            cats.dedup();
            presence.push(cats);
            for (b, r) in by_block {
                raise_to(&mut blocks, b, r);
            }
        }
        blocks.sort_by_key(|b| b.0);
        let contact = presence
            .iter()
            .enumerate()
            .map(|(l, here)| {
                let below = l.checked_sub(1).and_then(|b| presence.get(b));
                below.map_or_else(Vec::new, |below| {
                    let mut c: Vec<i64> = here
                        .iter()
                        .filter(|k| !below.contains(k))
                        .chain(below.iter().filter(|k| !here.contains(k)))
                        .copied()
                        .collect();
                    c.sort_unstable();
                    c
                })
            })
            .collect();
        Self {
            wall: wall_filament(cfg, orders, top),
            blocks,
            contact,
        }
    }

    /// Where the block of category `cat` starts along the depth, in rows, and where it ends (None: at the
    /// tower's back). None when the plan has no block for it.
    pub(crate) fn block(&self, cat: i64) -> Option<(f64, Option<f64>)> {
        let k = self.blocks.iter().position(|b| b.0 == cat)?;
        let from: f64 = self.blocks.iter().take(k).map(|b| b.1).sum();
        let to = (k + 1 < self.blocks.len()).then(|| from + self.blocks.get(k).map_or(0.0, |b| b.1));
        Some((from, to))
    }

    /// True when a change into a filament of category `cat` on layer `layer` is a contact change.
    pub(crate) fn contact(&self, layer: usize, cat: i64) -> bool {
        self.blocks.len() > 1 && self.contact.get(layer).is_some_and(|c| c.contains(&cat))
    }
}

/// The filament that prints a type 1 tower's wall for the whole print: `wipe_tower_filament` when set; otherwise,
/// counting for each filament the tower layers it is on (a layer with changes counts the filament it starts with
/// and each one it changes to, once each; a layer without changes the one it holds), the most counted filament of
/// the most counted adhesion category (ties to the lower category, then the lower filament).
pub(crate) fn wall_filament(cfg: &PrintConfig, orders: &[Vec<u8>], top: usize) -> u8 {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a filament slot"
    )]
    let set = cfg.raw_number("wipe_tower_filament", 0.0).clamp(0.0, 255.0) as u8;
    if set > 0 {
        return set;
    }
    let mut by_filament: Vec<(i64, f64)> = Vec::new();
    let mut by_cat: Vec<(i64, f64)> = Vec::new();
    let mut cur = 0u8;
    for order in orders.iter().take(top + 1) {
        let mut on: Vec<u8> = Vec::new();
        for &t in order {
            if cur != 0 && t != cur {
                on.push(cur);
                on.push(t);
            }
            cur = t;
        }
        if on.is_empty() && cur != 0 {
            on.push(cur);
        }
        on.sort_unstable();
        on.dedup();
        let mut cats: Vec<i64> = on.iter().map(|&s| block_of(cfg, s)).collect();
        cats.sort_unstable();
        cats.dedup();
        for &s in &on {
            add_to(&mut by_filament, i64::from(s), 1.0);
        }
        for c in cats {
            add_to(&mut by_cat, c, 1.0);
        }
    }
    let best = |list: &[(i64, f64)], keep: &dyn Fn(i64) -> bool| {
        list.iter()
            .filter(|e| keep(e.0))
            .fold(None::<(i64, f64)>, |m, &e| match m {
                Some(b) if b.1 > e.1 || (b.1.total_cmp(&e.1).is_eq() && b.0 < e.0) => Some(b),
                _ => Some(e),
            })
            .map(|e| e.0)
    };
    let Some(cat) = best(&by_cat, &|_| true) else {
        return 0;
    };
    best(&by_filament, &|s| {
        block_of(cfg, u8::try_from(s).unwrap_or(0)) == cat
    })
    .and_then(|s| u8::try_from(s).ok())
    .unwrap_or(0)
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
    // Each adhesion category's block is as deep as the most its changes take on any layer.
    let deepest = |w: f64| -> f64 {
        let line = w - 2.0 * pw;
        if line <= 1e-9 {
            return 0.0;
        }
        let mut cur = 0u8;
        let mut most: Vec<(i64, f64)> = Vec::new();
        for (l, order) in orders.iter().enumerate().take(top + 1) {
            let h = thickness(l);
            let mut by_block: Vec<(i64, f64)> = Vec::new();
            for &t in order {
                if cur != 0 && t != cur {
                    let p = change_purge(cfg, tools, cur, t);
                    let length = p.wipe / bead(pw, h);
                    let mut d = (length / line).ceil() * pw;
                    if p.ram > 0.0 {
                        d += ram_rows(cfg, p, w, h) * pw;
                    }
                    add_to(&mut by_block, block_of(cfg, t), d);
                }
                cur = t;
            }
            for (b, d) in by_block {
                raise_to(&mut most, b, d);
            }
        }
        most.iter().map(|b| b.1).sum()
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
    if let Some(line) = p.ram_line {
        // A single nozzle's lines run 1.5 wall beads in from each side, `line.pitch` apart, on a type 2 tower's
        // rows (`wipe_tower_extra_flow` times `wipe_tower_extra_spacing` wall beads apart).
        let lines = ram_lines(p.ram, (width - 3.0 * wall_w).max(1.0), bead(line.width, h));
        let extra_flow = (cfg.raw_number("wipe_tower_extra_flow", 100.0) / 100.0).clamp(0.5, 3.0);
        let extra_spacing = (cfg.raw_number("wipe_tower_extra_spacing", 100.0) / 100.0).clamp(0.5, 5.0);
        return (lines * line.pitch / (wall_w * extra_flow * extra_spacing) - 1e-9).ceil();
    }
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

/// Lines a single nozzle's ramming of `volume` mm3 takes at `area` mm2 a bead, `row_len` mm a line: the last one
/// stops at the volume.
fn ram_lines(volume: f64, row_len: f64, area: f64) -> f64 {
    (volume / (row_len * area) - 1e-9).ceil().max(1.0)
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
    // Each filament's own cross-section: the flush is pushed with the new one.
    let area = |i: i64| cfg.filament_area(slot(i));
    // Feed rate that melts filament at the filament's volumetric limit, mm/min, in whole units as Bambu Studio
    // writes it (`;VG1 E... F623` for 25 mm3/s), 100 when that is 0; 200 for the old filament before the first.
    let feed = |i: i64| {
        if i < 0 {
            return 200.0;
        }
        let v = per_slot_raw(cfg, "filament_max_volumetric_speed", slot(i), 15.0);
        let f = (v / area(i) * 60.0).floor();
        if f > 0.0 { f } else { 100.0 }
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
    let length = volume / area(next);
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

/// A filament's `filament_ramming_parameters` up to the `|`: the line width and pitch, percent, then the ramming
/// speeds, mm3/s.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RamTokens {
    pub(crate) width: f64,
    pub(crate) pitch: f64,
    pub(crate) speeds: Vec<f64>,
}

/// The `filament_ramming_parameters` of filament `slot` (1-based): its entry in the list (the last entry past the
/// end), or the one value of a setting that is not a list. None when it is absent, lists no speed after the first
/// two tokens, or has a token that is not a number before the `|`.
pub(crate) fn ramming_tokens(cfg: &PrintConfig, slot: u8) -> Option<RamTokens> {
    let text = match cfg.raw.get("filament_ramming_parameters")? {
        serde_json::Value::Array(a) => a.get(usize::from(slot.max(1) - 1)).or_else(|| a.last())?,
        v => v,
    }
    .as_str()?;
    let head = text.split('|').next().unwrap_or("");
    let numbers: Option<Vec<f64>> = head.split_whitespace().map(|t| t.parse().ok()).collect();
    match numbers?.as_slice() {
        [width, pitch, speeds @ ..] if !speeds.is_empty() => Some(RamTokens {
            width: *width,
            pitch: *pitch,
            speeds: speeds.to_vec(),
        }),
        _ => None,
    }
}

/// With `wipe_tower_no_sparse_layers` the tower prints only on its first layer and the layers with a tool change, each
/// on top of the tower as it stands: one layer (that layer's height) above the last tower layer, never above the layer
/// itself. `layers` gives, from the bottom up to the layer asked about, whether the tower prints on it, its top and
/// its height, mm; the last entry is that layer. Gives how far below the layer's top its tower prints, mm (0 when the
/// tower is level with it).
pub(crate) fn sunk_by(layers: impl IntoIterator<Item = (bool, f64, f64)>) -> f64 {
    let mut stands: Option<f64> = None;
    let mut last = (0.0, 0.0);
    for (prints, top, h) in layers {
        // Level within a micron: the heights add up in floating point.
        last = (
            top,
            stands.map_or(top, |s| if s + h < top - 1e-3 { s + h } else { top }),
        );
        if prints {
            stands = Some(last.1);
        }
    }
    (last.0 - last.1).max(0.0)
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
        let Ok(Some(p)) = place(&c, 2, &rows, None, &[part(96.0, 117.0, 160.0, 139.0)], &[], 50.0) else {
            panic!("placed")
        };
        let Some(t) = p.tower(&c, 2) else { panic!("tower") };
        assert_eq!(p.reason, TowerReason::MovedOntoBed);
        assert!((p.origin[0] - 15.0).abs() < 1e-9, "x {}", p.origin[0]);
        // The brim's outermost bead keeps the 1 mm margin to the edge.
        let r = t.reach(t.print_margin(c.initial_layer_print_height, 50.0));
        assert!(
            (p.origin[1] + r[3] - 255.0).abs() < 1e-9,
            "back edge {} of a {:.1} mm deep tower",
            p.origin[1] + r[3],
            t.depth
        );
        assert!(t.depth > 40.0);
    }

    #[test]
    fn placement_reserves_the_skirt_around_the_tower_at_the_bed_edge() {
        for (auto, shield) in [(false, false), (true, false), (false, true), (true, true)] {
            let mut c = tower_cfg(&[
                ("prime_tower_auto_position", serde_json::json!(auto)),
                ("wipe_tower_x", serde_json::json!([0.0])),
                ("wipe_tower_y", serde_json::json!([200.0])),
                ("skirt_loops", serde_json::json!(2)),
                ("skirt_distance", serde_json::json!(6.0)),
            ]);
            c.skirt_loops = 2;
            c.skirt_distance = 6.0;
            if shield {
                c.skirt_height = 0;
                c.raw.insert("draft_shield".into(), serde_json::json!("enabled"));
            }
            let parts = [part(60.0, 20.0, 240.0, 240.0)];
            let Ok(Some(p)) = place(&c, 3, &rows_for(60.0), None, &parts, &[], 15.0) else {
                panic!("placed")
            };
            let t = p.tower(&c, 3).expect("tower");
            let r = t.reach(t.brim.max(0.0));
            let skirt =
                c.skirt_distance + (f64::from(c.skirt_loops) - 0.5) * crate::session::skirt_spacing_mm(&c);
            let bed = c.bed_rect();
            assert!(
                p.origin[0] + r[0] - skirt >= bed[0],
                "left skirt edge {}",
                p.origin[0] + r[0] - skirt
            );
            assert!(p.origin[1] + r[1] - skirt >= bed[1]);
            assert!(p.origin[0] + r[2] + skirt <= bed[2]);
            assert!(p.origin[1] + r[3] + skirt <= bed[3]);
        }
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
        let Ok(Some(p)) = place(&c, 2, &rows_for(60.0), None, &parts, &[], 50.0) else {
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
        let Ok(Some(again)) = place(&c, 2, &rows_for(60.0), None, &parts, &[], 50.0) else {
            panic!("placed")
        };
        assert_eq!(p, again);
    }

    #[test]
    fn a_flat_exclusion_list_is_a_rectangle_per_four_points() {
        // The Qidi X-Plus 4 lists two corner strips as 13 points, joined along the bed's edges. Orca reads each four
        // points as one box (PartPlate::calc_bounding_boxes); one box round all of them covered the whole bed.
        let c = tower_cfg(&[
            ("prime_tower_auto_position", serde_json::json!(true)),
            (
                "printable_area",
                serde_json::json!(["0x0", "305x0", "305x305", "0x305"]),
            ),
            (
                "bed_exclude_area",
                serde_json::json!([
                    "0x305", "0x302", "35x302", "35x305", "305x305", "305x305", "305x305", "305x20",
                    "293x20", "293x0", "305x0", "305x20", "305x305"
                ]),
            ),
        ]);
        let parts = [part(120.0, 120.0, 185.0, 185.0)];
        let Ok(Some(p)) = place(&c, 2, &rows_for(60.0), None, &parts, &[], 50.0) else {
            panic!("placed")
        };
        assert!(p.tower(&c, 2).is_some());
    }

    #[test]
    fn an_objects_room_is_its_brim_or_support_pad_and_the_skirt_round_it() {
        let brim = tower_cfg(&[
            ("skirt_loops", serde_json::json!(0)),
            ("brim_width", serde_json::json!(5)),
        ]);
        assert!((room(&brim) - 5.0).abs() < 1e-9, "{}", room(&brim));
        // the support's first layer: the 2 mm pad, the expansion and a line
        let support = tower_cfg(&[
            ("skirt_loops", serde_json::json!(0)),
            ("brim_width", serde_json::json!(0)),
            ("enable_support", serde_json::json!(true)),
            ("support_expansion", serde_json::json!(1.5)),
        ]);
        assert!(room(&support) > 3.5, "{}", room(&support));
        let skirt = tower_cfg(&[
            ("skirt_type", serde_json::json!("perobject")),
            ("skirt_loops", serde_json::json!(2)),
            ("skirt_distance", serde_json::json!(3)),
            ("brim_width", serde_json::json!(0)),
        ]);
        assert!(room(&skirt) > 3.5, "{}", room(&skirt));
    }

    #[test]
    fn a_tower_too_deep_for_any_free_spot_gets_wider() {
        // Only a strip 70 mm deep is free at the front; the purge needs about 120 mm at 35 mm wide.
        let c = tower_cfg(&[("prime_tower_auto_position", serde_json::json!(true))]);
        let parts = [part(1.0, 75.0, 255.0, 255.0)];
        let Ok(Some(p)) = place(&c, 2, &rows_for(800.0), None, &parts, &[], 50.0) else {
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
                &[],
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
        let Ok(Some(p)) = place(&c, 2, &rows, None, &[], &[], 20.0) else {
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
        let Ok(Some(tall)) = place(&c, 2, &rows, None, &[], &[], 250.0) else {
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
        let Ok(Some(p)) = place(&c, 2, &rows, Some((w, d)), &[], &[], 60.0) else {
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
            let Ok(Some(p)) = place(&c, 8, &rows, None, &parts, &[], 80.0) else {
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
        // A third of `prime_tower_max_speed` (90 mm/s when unset), then 0.375, 0.458 and 0.875 of it, then 0.875 of it
        // plus 50 mm/min on every row after.
        let hold = 78.75 + 50.0 / 60.0;
        for (got, want) in speeds.iter().zip([29.7, 33.75, 41.22, 78.75, hold, hold, hold]) {
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
    fn the_wall_opens_level_with_each_wipe_start() {
        // A P1S rectangle tower 20 by 10 mm at the origin.
        let c = cfg(&[
            ("enable_prime_tower", serde_json::json!(true)),
            ("printer_model", serde_json::json!("Bambu Lab P1S")),
            ("wipe_tower_wall_type", serde_json::json!("rectangle")),
        ]);
        let Some(t) = Tower::new(&c, 2, 10.0).map(|t| t.shaped(20.0, 0.0).at([0.0, 0.0])) else {
            panic!("tower")
        };
        let w = t.wall_w;
        let pts = |p: &TowerPath| p.points.iter().map(|q| (q.x_mm(), q.y_mm())).collect::<Vec<_>>();
        let walk = |pieces: &[TowerPath]| -> f64 {
            pieces
                .iter()
                .flat_map(|p| p.points.windows(2).map(|s| s[0].dist_mm(s[1])))
                .sum()
        };
        let whole = walk(&[t.wall(false, 1.0)]);
        // Two wipes, one in the middle of the left side and one near the front left corner: two openings, the
        // second wrapping the corner. The wall starts after one of them and hops the other.
        let starts = [t.row_start(0.0), t.row_start(8.0)];
        let pieces = t.wall_pieces(false, 1.0, &starts);
        assert_eq!(pieces.len(), 2);
        assert_eq!(pieces.iter().map(|p| p.hop).collect::<Vec<_>>(), [false, true]);
        assert!(
            (whole - walk(&pieces) - 2.0 * 5.0 * w).abs() < 1e-3,
            "5 beads of wall left out per opening"
        );
        // Each opening spans 2.5 beads either side of the wall's crossing with the wipe's row, on the left side.
        let (s0, s1) = (starts[0], starts[1]);
        let ends: Vec<(f64, f64)> = pieces
            .iter()
            .flat_map(|p| [pts(p)[0], *pts(p).last().unwrap()])
            .collect();
        let near = |a: (f64, f64), b: (f64, f64)| (a.0 - b.0).abs() < 1e-3 && (a.1 - b.1).abs() < 1e-3;
        assert!(
            ends.iter().any(|&e| near(e, (w / 2.0, s1.1 + 2.5 * w))),
            "{ends:?}"
        );
        assert!(
            ends.iter().any(|&e| near(e, (w / 2.0, s1.1 - 2.5 * w))),
            "{ends:?}"
        );
        // The opening at the corner runs 2.5 beads up the side from the row and the rest along the front.
        let below = s0.1 - w / 2.0;
        assert!(
            ends.iter().any(|&e| near(e, (w / 2.0, s0.1 + 2.5 * w))),
            "{ends:?}"
        );
        assert!(
            ends.iter()
                .any(|&e| near(e, (w / 2.0 + 2.5 * w - below, w / 2.0))),
            "{ends:?}"
        );
        // Openings that overlap merge; a type 2 tower and skip points off keep the closed wall.
        let merged = t.wall_pieces(false, 1.0, &[t.row_start(4.0), t.row_start(5.0)]);
        assert_eq!(merged.len(), 1);
        let off = Tower::new(
            &cfg(&[
                ("enable_prime_tower", serde_json::json!(true)),
                ("printer_model", serde_json::json!("Bambu Lab P1S")),
                ("prime_tower_skip_points", serde_json::json!(false)),
            ]),
            2,
            10.0,
        )
        .map(|t| t.shaped(20.0, 0.0))
        .unwrap();
        assert_eq!(off.wall_pieces(false, 1.0, &starts).len(), 1);
        let type2 = Tower::new(
            &cfg(&[
                ("enable_prime_tower", serde_json::json!(true)),
                ("wipe_tower_type", serde_json::json!("type2")),
            ]),
            2,
            10.0,
        )
        .unwrap();
        assert_eq!(type2.wall_pieces(false, 1.0, &starts).len(), 1);
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
        assert!((purge_volume(&semm, 2, 1, 2) - 280.0).abs() < 1e-9);
    }

    #[test]
    fn a_shared_nozzle_purges_at_least_the_new_filaments_minimal_purge() {
        let semm = |matrix: serde_json::Value, floor: Option<serde_json::Value>| {
            let mut pairs = vec![
                ("flush_volumes_matrix", matrix),
                ("flush_multiplier", serde_json::json!(0.3)),
            ];
            pairs.extend(floor.map(|f| ("filament_minimal_purge_on_wipe_tower", f)));
            cfg(&pairs)
        };
        // 50 x 0.3 is 15: into filament 2 its floor of 40 wins, into filament 1 its 15 matches it.
        let low = semm(
            serde_json::json!([0, 50, 50, 0]),
            Some(serde_json::json!(["15", "40"])),
        );
        assert!((purge_volume(&low, 2, 1, 2) - 40.0).abs() < 1e-9);
        assert!((change_purge(&low, 2, 1, 2).wipe - 40.0).abs() < 1e-9);
        assert!((purge_volume(&low, 2, 2, 1) - 15.0).abs() < 1e-9);
        // Above the floor the flush stands, exactly: 280 x 0.3, and 280 x 1.0.
        let stock = semm(
            serde_json::json!([0, 280, 280, 0]),
            Some(serde_json::json!([15, 15])),
        );
        assert!((purge_volume(&stock, 2, 1, 2) - 84.0).abs() < 1e-9);
        let mut full = stock.clone();
        full.raw
            .insert("flush_multiplier".to_owned(), serde_json::json!(1.0));
        assert!((purge_volume(&full, 2, 1, 2) - 280.0).abs() < 1e-9);
        // Unset, the floor is 15: 10 x 0.3 is 3.
        let unset = semm(serde_json::json!([0, 10, 10, 0]), None);
        assert!((purge_volume(&unset, 2, 1, 2) - 15.0).abs() < 1e-9);
        // With no matrix the change purges `prime_volume`, and the floor holds there too.
        let fallback = |pv: i32| {
            cfg(&[
                ("prime_volume", serde_json::json!(pv)),
                ("filament_minimal_purge_on_wipe_tower", serde_json::json!(40)),
            ])
        };
        assert!((purge_volume(&fallback(5), 2, 1, 2) - 40.0).abs() < 1e-9);
        assert!((purge_volume(&fallback(45), 2, 1, 2) - 45.0).abs() < 1e-9);
        // A tool changer's `prime_volume` and a type 1 tower's prime volume take no floor.
        let tools = cfg(&[
            ("single_extruder_multi_material", serde_json::json!(0)),
            ("prime_volume", serde_json::json!(5)),
            ("filament_minimal_purge_on_wipe_tower", serde_json::json!(40)),
        ]);
        assert!((purge_volume(&tools, 2, 1, 2) - 5.0 * PURGE_EXTRA).abs() < 1e-9);
        let bambu = cfg(&[
            ("printer_model", serde_json::json!("Bambu Lab A1")),
            ("filament_prime_volume", serde_json::json!([5, 5])),
            ("filament_minimal_purge_on_wipe_tower", serde_json::json!(40)),
        ]);
        assert!((purge_volume(&bambu, 2, 1, 2) - 5.0).abs() < 1e-9);
    }

    #[test]
    fn a_zero_flush_entry_purges_the_floor_not_the_prime_volume() {
        let zero = |pv: i32, floor: Option<i32>| {
            let mut pairs = vec![
                ("flush_volumes_matrix", serde_json::json!([0, 0, 0, 0])),
                ("flush_multiplier", serde_json::json!(0.3)),
                ("prime_volume", serde_json::json!(pv)),
            ];
            pairs.extend(floor.map(|f| ("filament_minimal_purge_on_wipe_tower", serde_json::json!([f, f]))));
            cfg(&pairs)
        };
        for pv in [5, 90] {
            assert!(
                (purge_volume(&zero(pv, Some(40)), 2, 1, 2) - 40.0).abs() < 1e-9,
                "prime volume {pv}"
            );
            assert!((change_purge(&zero(pv, Some(40)), 2, 2, 1).wipe - 40.0).abs() < 1e-9);
            assert!((purge_volume(&zero(pv, None), 2, 1, 2) - 15.0).abs() < 1e-9);
        }
        // The filament estimate counts the same purge.
        assert!((change_waste(&zero(90, Some(40)), 2, 1, 2) - 40.0).abs() < 1e-9);
    }

    #[test]
    fn what_the_objects_take_comes_on_top_of_the_floor() {
        let semm = |matrix: i32, floor: i32| {
            cfg(&[
                ("flush_volumes_matrix", serde_json::json!([0, matrix, matrix, 0])),
                ("flush_multiplier", serde_json::json!(0.3)),
                (
                    "filament_minimal_purge_on_wipe_tower",
                    serde_json::json!([floor, floor]),
                ),
            ])
        };
        // 50 x 0.3 is under a floor of 40: infill taking 17 still leaves 40 on the tower.
        let low = semm(50, 40);
        let wipe = change_purge(&low, 2, 1, 2).wipe;
        assert!((tower_share(&low, 2, wipe, 17.0) - 40.0).abs() < 1e-9);
        // 280 x 0.3 is 84: 17 taken leaves 67, which a floor of 80 lifts, and a floor of 15 does not.
        let high = semm(280, 80);
        assert!((tower_share(&high, 2, change_purge(&high, 2, 1, 2).wipe, 17.0) - 80.0).abs() < 1e-9);
        let stock = semm(280, 15);
        assert!((tower_share(&stock, 2, change_purge(&stock, 2, 1, 2).wipe, 17.0) - 67.0).abs() < 1e-9);
        // Support taking more than the purge still leaves the floor.
        assert!((tower_share(&stock, 2, 84.0, 120.0) - 15.0).abs() < 1e-9);
        // A tower that only primes (a tool changer, a Bambu Lab printer) purges what is left, floor or not.
        let tools = cfg(&[
            ("single_extruder_multi_material", serde_json::json!(0)),
            ("filament_minimal_purge_on_wipe_tower", serde_json::json!(40)),
        ]);
        assert!((tower_share(&tools, 2, 49.5, 17.0) - 32.5).abs() < 1e-9);
        let bambu = cfg(&[
            ("printer_model", serde_json::json!("Bambu Lab A1")),
            ("filament_minimal_purge_on_wipe_tower", serde_json::json!(40)),
        ]);
        assert!((tower_share(&bambu, 2, 45.0, 17.0) - 28.0).abs() < 1e-9);
    }

    #[test]
    fn a_shared_nozzle_saves_the_wall_and_the_fill_no_purge_uses_once() {
        let c = tower_cfg(&[
            ("wipe_tower_type", serde_json::json!("type2")),
            ("prime_tower_width", serde_json::json!(60)),
            ("flush_volumes_matrix", serde_json::json!([0, 280, 280, 0])),
            ("flush_multiplier", serde_json::json!(0.3)),
        ]);
        assert!(flush_on_tower(&c) && saves_first_purge(&c));
        let h = 0.2;
        // Planned for one change of 84 mm3 a layer.
        let rows = Tower::new(&c, 2, 1.0).unwrap().purge(84.0, h, false, 0.0).1;
        let t = Tower::new(&c, 2, rows).unwrap();
        assert!((t.planned_rows(&c, 2, 1, &[2], h, false) - rows).abs() < 1e-9);
        let wall = path_volume(&t.wall(false, 0.0), h);
        // The one purge as planned leaves no depth to fill, so only the wall comes off, and only once.
        let saved = t.saved_first_wipe(&c, 84.0, h, false, rows, 2);
        assert!(
            (saved - (84.0 - wall)).abs() < 1e-9,
            "{saved} against {}",
            84.0 - wall
        );
        // Depth no purge uses is filled anyway, so its fill comes off too.
        let half = t.saved_first_wipe(&c, 84.0, h, false, rows / 2.0, 2);
        assert!(half < saved - 1.0, "{half}");
        // A first layer prints dense over all the purge leaves: the change purges the floor.
        assert!((t.saved_first_wipe(&c, 84.0, h, true, 0.0, 2) - 15.0).abs() < 1e-9);
        // A tool changer keeps the save it had.
        let tools = tower_cfg(&[
            ("wipe_tower_type", serde_json::json!("type2")),
            ("single_extruder_multi_material", serde_json::json!(0)),
        ]);
        assert!(!flush_on_tower(&tools) && saves_first_purge(&tools));
    }

    /// A two-filament MK4 with the MMU and a type 2 tower `width` wide that takes the whole flush (280 x 0.3), both
    /// filaments ramming with `tokens`; `extra` over it.
    fn mmu_ram(width: f64, tokens: &str, extra: &[(&str, serde_json::Value)]) -> PrintConfig {
        let mut pairs = vec![
            ("printer_model", serde_json::json!("Prusa MK4")),
            ("wipe_tower_type", serde_json::json!("type2")),
            ("single_extruder_multi_material", serde_json::json!("1")),
            ("prime_tower_width", serde_json::json!(width)),
            ("flush_volumes_matrix", serde_json::json!([0, 280, 280, 0])),
            ("flush_multiplier", serde_json::json!(0.3)),
            ("enable_filament_ramming", serde_json::json!("1")),
            ("filament_ramming_parameters", serde_json::json!([tokens, tokens])),
        ];
        pairs.extend(extra.iter().cloned());
        tower_cfg(&pairs)
    }

    const STOCK_RAM: &str = "250 100 40 40 40 40 40 | 0.05 40 0.45 40 0.95 40 1.45 40 1.95 40";

    #[test]
    fn a_shared_nozzle_rams_a_quarter_second_at_each_listed_speed() {
        let ram = |c: &PrintConfig| change_purge(c, 2, 1, 2).ram;
        assert!((ram(&mmu_ram(60.0, STOCK_RAM, &[])) - 50.0).abs() < 1e-9);
        assert!((ram(&mmu_ram(60.0, "250 100 20 20 20 20 20| 0.05 20", &[])) - 25.0).abs() < 1e-9);
        // The first two tokens and what follows the `|` do not change the volume.
        assert!((ram(&mmu_ram(60.0, "500 150 40 40 40 40 40", &[])) - 50.0).abs() < 1e-9);
        assert!((ram(&mmu_ram(60.0, "250 100 10 20 30 40 50 60 | 0.05 40", &[])) - 52.5).abs() < 1e-9);
        // The old filament's tokens: out of filament 2 rams 25, out of filament 1 rams 50.
        let mix = mmu_ram(
            60.0,
            STOCK_RAM,
            &[(
                "filament_ramming_parameters",
                serde_json::json!([STOCK_RAM, "250 100 20 20 20 20 20"]),
            )],
        );
        assert!((change_purge(&mix, 2, 2, 1).ram - 25.0).abs() < 1e-9);
        assert!((change_purge(&mix, 2, 1, 2).ram - 50.0).abs() < 1e-9);
        // No speeds, an empty string or ramming off: nothing rammed.
        for tokens in ["250 100", "", "250 100 | 0.05 40"] {
            let c = mmu_ram(60.0, tokens, &[]);
            assert!(
                ram(&c).abs() < 1e-9 && change_purge(&c, 2, 1, 2).ram_line.is_none(),
                "{tokens:?}"
            );
        }
        let off = mmu_ram(
            60.0,
            STOCK_RAM,
            &[("enable_filament_ramming", serde_json::json!("0"))],
        );
        assert!(ram(&off).abs() < 1e-9);
        // Without the setting nothing is rammed either.
        let mut unset = mmu_ram(60.0, STOCK_RAM, &[]);
        unset.raw.remove("filament_ramming_parameters");
        assert!(ram(&unset).abs() < 1e-9);
        // With the flush off the tower it still rams.
        let pit0 = mmu_ram(
            60.0,
            STOCK_RAM,
            &[("purge_in_prime_tower", serde_json::json!("0"))],
        );
        assert!((ram(&pit0) - 50.0).abs() < 1e-9);
        // A Bambu Lab printer and a tool changer do not ram by these tokens.
        let a1 = mmu_ram(
            60.0,
            STOCK_RAM,
            &[("printer_model", serde_json::json!("Bambu Lab A1"))],
        );
        assert!(ram(&a1).abs() < 1e-9);
        let tools = mmu_ram(
            60.0,
            STOCK_RAM,
            &[("single_extruder_multi_material", serde_json::json!("0"))],
        );
        assert!(ram(&tools).abs() < 1e-9 && change_purge(&tools, 2, 1, 2).ram_line.is_none());
    }

    /// The ramming lines of a change on `c` from the tower's first row: each line's Y, its X ends from the tower's
    /// origin and its width, the volume laid, the paths' feeds (mm/s) and the rows taken.
    #[allow(clippy::type_complexity, reason = "a test summary")]
    fn ram_lines_of(c: &PrintConfig) -> (Vec<(f64, f64, f64, f64)>, f64, Vec<f64>, f64, Option<(f64, bool)>) {
        let p = change_purge(c, 2, 1, 2);
        let t = Tower::new(c, 2, 40.0).unwrap();
        let (x0, y0) = (t.x, t.y);
        let (paths, rows, end) = t.ramming(c, p, 1, 0.2, 0.0);
        let mut lines: Vec<(f64, f64, f64, f64)> = Vec::new();
        let mut volume = 0.0;
        for path in &paths {
            assert!(path.ram && path.points.len() == 2);
            let (a, b) = (path.points[0], path.points[1]);
            assert!((a.y_mm() - b.y_mm()).abs() < 1e-6, "a ramming piece runs along X");
            volume += path_volume(path, 0.2);
            let (y, xa, xb) = (a.y_mm() - y0, a.x_mm() - x0, b.x_mm() - x0);
            match lines.last_mut() {
                Some(l) if (l.0 - y).abs() < 1e-6 => {
                    l.1 = l.1.min(xa.min(xb));
                    l.2 = l.2.max(xa.max(xb));
                }
                _ => lines.push((y, xa.min(xb), xa.max(xb), f64::from(path.width_mm))),
            }
        }
        let feeds = paths.iter().map(|p| f64::from(p.speed_mm_s)).collect();
        (lines, volume, feeds, rows, end)
    }

    #[test]
    fn a_shared_nozzle_rams_in_wide_lines_across_the_tower() {
        let c = mmu_ram(60.0, STOCK_RAM, &[]);
        let (lines, volume, feeds, rows, end) = ram_lines_of(&c);
        assert_eq!(lines.len(), 4, "{lines:?}");
        assert!((volume - 50.0).abs() < 1e-3, "{volume}");
        for (k, l) in lines.iter().enumerate() {
            assert!((l.3 - 1.25).abs() < 1e-6, "width {}", l.3);
            // Every line reaches 59.25; the last runs back from there and stops short of 0.75.
            assert!((l.2 - 59.25).abs() < 1e-3, "line {k} ends at {}", l.2);
            if k < 3 {
                assert!((l.1 - 0.75).abs() < 1e-3, "line {k} starts at {}", l.1);
            }
            if k > 0 {
                assert!((l.0 - lines[k - 1].0 - 1.25).abs() < 1e-6, "pitch");
            }
        }
        // The first line is centered half a line into the band below the first row.
        assert!(
            (lines[0].0 - (2.0 * 0.5 - 0.25 + 0.625)).abs() < 1e-6,
            "{}",
            lines[0].0
        );
        let last = lines[3].2 - lines[3].1;
        assert!((last - 31.61).abs() < 0.01, "last line {last}");
        // Five pieces of 10 mm3 at 40 mm3/s over the 1.25 mm bead (F9941), one split where the line turns.
        assert!(feeds.iter().all(|f| (f * 60.0 - 9941.0).abs() < 1.0), "{feeds:?}");
        assert!(feeds.len() > 5);
        // Four lines 1.25 apart take ten rows; the fourth line runs right to left and stops 31.6 mm in.
        assert!((rows - 10.0).abs() < 1e-9, "{rows}");
        assert!((rows - ram_rows(&c, change_purge(&c, 2, 1, 2), 60.0, 0.2)).abs() < 1e-9);
        let (x, right) = end.unwrap();
        assert!(!right && (x - (59.25 - 31.611)).abs() < 0.01, "{x}");
        // A 40 mm tower: six lines, the last 14.6 mm.
        let (lines, volume, _, rows, _) = ram_lines_of(&mmu_ram(40.0, STOCK_RAM, &[]));
        assert_eq!(lines.len(), 6);
        assert!((volume - 50.0).abs() < 1e-3 && (lines[0].2 - 39.25).abs() < 1e-3);
        assert!((lines[5].2 - lines[5].1 - 14.6).abs() < 0.05, "{lines:?}");
        assert!((rows - 15.0).abs() < 1e-9);
        // The first token 500: two lines 2.5 wide and 2.5 apart.
        let (lines, ..) = ram_lines_of(&mmu_ram(60.0, "500 100 40 40 40 40 40", &[]));
        assert_eq!(lines.len(), 2);
        assert!((lines[0].3 - 2.5).abs() < 1e-6 && (lines[1].0 - lines[0].0 - 2.5).abs() < 1e-6);
        // The second token 150, or `wipe_tower_extra_spacing` 150%: lines 1.875 apart.
        for c in [
            mmu_ram(60.0, "250 150 40 40 40 40 40", &[]),
            mmu_ram(
                60.0,
                STOCK_RAM,
                &[("wipe_tower_extra_spacing", serde_json::json!("150%"))],
            ),
        ] {
            let (lines, ..) = ram_lines_of(&c);
            assert_eq!(lines.len(), 4);
            assert!((lines[1].0 - lines[0].0 - 1.875).abs() < 1e-6, "{lines:?}");
        }
        // Each speed is its own feed over the bead: 10 to 60 mm3/s is F2485 to F14912.
        let (_, volume, feeds, ..) = ram_lines_of(&mmu_ram(60.0, "250 100 10 20 30 40 50 60", &[]));
        assert!((volume - 52.5).abs() < 1e-3);
        let (lo, hi) = feeds
            .iter()
            .fold((f64::MAX, 0.0f64), |a, f| (a.0.min(*f), a.1.max(*f)));
        assert!(
            (lo * 60.0 - 2485.0).abs() < 1.0 && (hi * 60.0 - 14912.0).abs() < 2.0,
            "{feeds:?}"
        );
    }

    #[test]
    fn a_type_1_tower_wipes_each_filaments_own_prime_volume() {
        let bambu = |extra: &[(&str, serde_json::Value)]| {
            let mut pairs = vec![("printer_model", serde_json::json!("Bambu Lab A1"))];
            pairs.extend(extra.iter().cloned());
            cfg(&pairs)
        };
        // A listed value wins, `prime_volume` is not read, and a filament the list stops short of gets 45.
        let c = bambu(&[
            ("filament_prime_volume", serde_json::json!(["30", "20"])),
            ("prime_volume", serde_json::json!(15)),
        ]);
        assert!((purge_volume(&c, 3, 2, 1) - 30.0).abs() < 1e-9);
        assert!((purge_volume(&c, 3, 1, 2) - 20.0).abs() < 1e-9);
        assert!((purge_volume(&c, 3, 1, 3) - DEFAULT_PRIME).abs() < 1e-9);
        // No list at all: 45 for every filament, whatever `prime_volume` says.
        let none = bambu(&[("prime_volume", serde_json::json!(15))]);
        assert!((purge_volume(&none, 2, 1, 2) - 45.0).abs() < 1e-9);
        // At least 1, and Saving wipes 15 on one nozzle too.
        let tiny = bambu(&[("filament_prime_volume", serde_json::json!([0.2, 0.2]))]);
        assert!((purge_volume(&tiny, 2, 1, 2) - 1.0).abs() < 1e-9);
        let saving = bambu(&[
            ("filament_prime_volume", serde_json::json!([45, 45])),
            ("prime_volume_mode", serde_json::json!("Saving")),
        ]);
        assert!((purge_volume(&saving, 2, 1, 2) - 15.0).abs() < 1e-9);
        // A type 2 tower keeps `prime_volume`.
        let other = cfg(&[
            ("single_extruder_multi_material", serde_json::json!(0)),
            ("filament_prime_volume", serde_json::json!([20, 20])),
            ("prime_volume", serde_json::json!(15)),
        ]);
        assert!((purge_volume(&other, 2, 1, 2) - 15.0 * PURGE_EXTRA).abs() < 1e-9);
    }

    #[test]
    fn the_wall_filament_is_the_most_counted_of_the_most_counted_category() {
        let c = |cats: serde_json::Value| {
            cfg(&[
                ("printer_model", serde_json::json!("Bambu Lab P1S")),
                ("filament_adhesiveness_category", cats),
            ])
        };
        // Filaments 1 and 2 on four layers, filament 3 on two.
        let orders = vec![
            vec![1, 2, 3],
            vec![3, 1, 2],
            vec![2, 1, 3],
            vec![3, 1, 2],
            vec![2, 1],
            vec![1, 2],
        ];
        assert_eq!(
            wall_filament(&c(serde_json::json!([100, 100, 100])), &orders, 5),
            1
        );
        // Filament 3 alone in its category loses to the category of the other two, and 2 wins a tie over 3 below.
        assert_eq!(
            wall_filament(&c(serde_json::json!([200, 100, 100])), &orders, 5),
            2
        );
        // `wipe_tower_filament` when set.
        let mut set = c(serde_json::json!([100, 100, 100]));
        set.raw
            .insert("wipe_tower_filament".to_owned(), serde_json::json!(3));
        assert_eq!(wall_filament(&set, &orders, 5), 3);
    }

    #[test]
    fn a_category_coming_onto_the_tower_makes_a_contact_layer() {
        let c = cfg(&[
            ("printer_model", serde_json::json!("Bambu Lab P1S")),
            ("enable_prime_tower", serde_json::json!(true)),
            ("filament_adhesiveness_category", serde_json::json!([100, 300])),
        ]);
        let t = Tower::new(&c, 2, 30.0).unwrap();
        // Filament 2 is on the tower on layers 2 and 3 and again from 6; on 7 filament 1 is not.
        let orders = vec![
            vec![1],
            vec![1],
            vec![1, 2],
            vec![2, 1],
            vec![1],
            vec![1],
            vec![1, 2],
            vec![2],
        ];
        let plan = TowerPlan::new(&c, 2, &orders, &|_| 0.2, 7, &t);
        let at = |cat: i64| (0..8).filter(|&l| plan.contact(l, cat)).collect::<Vec<usize>>();
        // Where the category comes on (2 and 6) and where it leaves (4); the change into it on 2 and 6 is a
        // contact change, the one on 3 is not.
        assert_eq!(at(300), vec![2, 4, 6]);
        assert_eq!(at(100), vec![7]);
        // Two blocks, filament 1's first; one category has no contact layers.
        assert_eq!(
            plan.blocks.iter().map(|b| b.0).collect::<Vec<_>>(),
            vec![100, 300]
        );
        let one = cfg(&[
            ("printer_model", serde_json::json!("Bambu Lab P1S")),
            ("filament_adhesiveness_category", serde_json::json!([100, 100])),
        ]);
        let plan = TowerPlan::new(&one, 2, &orders, &|_| 0.2, 7, &t);
        assert!((0..8).all(|l| !plan.contact(l, 100)));
    }

    #[test]
    fn the_first_layer_and_a_contact_wipe_fill_the_rows_depth_one_bead_apart() {
        let c = tower_cfg(&[("printer_model", serde_json::json!("Bambu Lab A1"))]);
        let t = Tower::new(&c, 2, 40.0).unwrap();
        let row_y = |paths: &[TowerPath]| -> Vec<f64> {
            let mut ys: Vec<f64> = paths
                .iter()
                .flat_map(|p| p.points.windows(2))
                .filter(|w| (w[0].y_mm() - w[1].y_mm()).abs() < 1e-6)
                .map(|w| w[0].y_mm())
                .collect();
            ys.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
            ys
        };
        let (later, n) = t.purge(45.0, 0.2, false, 0.0);
        let (first, n1) = t.purge(45.0, 0.2, true, 0.0);
        let (contact, n2) = t.purge_lead(45.0, 0.2, false, 0.0, None, true);
        assert!(
            (n - n1).abs() < 1e-9 && (n - n2).abs() < 1e-9,
            "the same rows taken"
        );
        let (yl, yf, yc) = (row_y(&later), row_y(&first), row_y(&contact));
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let dense = (n * 1.5).floor() as usize;
        assert_eq!((yf.len(), yc.len()), (dense, dense));
        assert!(((yf[1] - yf[0]).abs() - 0.5).abs() < 1e-6 && ((yl[1] - yl[0]).abs() - 0.75).abs() < 1e-6);
        assert!(later[0].nozzle_wipe && first[0].nozzle_wipe && !contact[0].nozzle_wipe);
        assert!(contact.iter().all(|p| p.speed_mm_s <= 20.0 + 1e-4));
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
        let wide = cfg(&[
            (
                "flush_volumes_matrix",
                serde_json::json!([0, 1, 2, 3, 0, 5, 6, 7, 0]),
            ),
            ("filament_minimal_purge_on_wipe_tower", serde_json::json!(0)),
        ]);
        assert_eq!(flush_entry(&wide, 2, 1, 0), Some(3.0));
        assert!((purge_volume(&wide, 2, 2, 1) - 3.0).abs() < 1e-9);
    }

    #[test]
    fn a_change_after_skipped_tower_layers_prints_on_the_tower_top() {
        let layers = |prints: &[bool]| -> Vec<(bool, f64, f64)> {
            prints
                .iter()
                .zip(1u32..)
                .map(|(&p, i)| (p, 0.2 * f64::from(i), 0.2))
                .collect()
        };
        // Level while every layer prints the tower.
        assert!(sunk_by(layers(&[true, true, true])).abs() < 1e-9);
        // Layers 2 to 4 skipped: layer 5 (top 1.2) prints one layer above layer 1's 0.4.
        assert!((sunk_by(layers(&[true, true, false, false, false, true])) - 0.6).abs() < 1e-9);
        // The next one stacks on that sunk layer, not on the layer heights.
        assert!((sunk_by(layers(&[true, true, false, false, false, true, false, true])) - 0.8).abs() < 1e-9);
        // The first tower layer stands at its own height.
        assert!(sunk_by(layers(&[false, false, true])).abs() < 1e-9);
    }
}
