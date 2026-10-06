// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Stage 7: G-code. Absolute XYZ, relative extrusion (`M83`), so layer chunks
//! concatenate without rewriting E. Layers are formatted in parallel and
//! written in order. Numbers are printed from integers (thousandths of a mm
//! for XYZ, 1e-5 mm for E), so output is the same on every platform.

use crate::config::{GcodeFlavor, PrintConfig};
use crate::error::Result;
use crate::fm::Fm as _;
use crate::geom::Point;
use crate::output::{Feature, LayerPaths, SliceOutput};
use crate::par;
use crate::par::Init as _;
use crate::template;
use i_overlay::i_float::int::point::IntPoint;
use std::io::Write;

/// Totals for the emitted G-code.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct GcodeStats {
    /// Estimated print time, seconds.
    pub time_s: f64,
    /// Filament length per slot (index 0 is slot 1), mm.
    pub filament_mm: Vec<f64>,
    pub filament_g: Vec<f64>,
    pub cost: f64,
    pub tool_changes: u32,
    pub bytes: u64,
    pub layers: u32,
}

/// Cross-section of a bead: a rectangle with semicircular sides (Orca's model).
pub fn bead_area(width: f64, height: f64) -> f64 {
    (width - height) * height + std::f64::consts::PI * (height / 2.0) * (height / 2.0)
}

/// One layer's G-code and what the file's totals need from it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LayerChunk {
    bytes: Vec<u8>,
    /// Seconds the layer's tool changes take beyond its moves.
    change_time_s: f64,
    /// Extrusion per slot in 1e-5 mm, index 0 is slot 1.
    e_units: Vec<i64>,
    tool_changes: u32,
    /// A custom G-code template that failed to render.
    error: Option<String>,
}

fn custom(
    base: &PrintConfig,
    key: &str,
    ctx: Option<&template::Context<'_>>,
    error: &mut Option<String>,
) -> String {
    let Some(ctx) = ctx else { return String::new() };
    match crate::customgcode::render(base, ctx, key) {
        Ok(t) => t.unwrap_or_default(),
        Err(e) => {
            error.get_or_insert(e);
            String::new()
        }
    }
}

fn custom_error(reason: String) -> crate::error::Error {
    if let Some(blocked) = reason.strip_prefix("safety: ") {
        return crate::error::Error::Blocked(blocked.to_owned());
    }
    crate::error::Error::Config {
        key: "custom_gcode",
        reason,
    }
}

/// G-code the person asked for at the start of a layer (a pause, a color
/// change, or their own commands), from the layer slider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayerGcode {
    /// The layer it is written at the start of, 0-based.
    pub layer: u32,
    /// `pause` (the profile's pause G-code), `color_change` (its color change G-code)
    /// or `custom` (the text in `gcode`).
    pub kind: String,
    pub gcode: Option<String>,
}

/// How to write the G-code, beyond the print settings.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EmitOptions {
    /// Pauses, color changes and custom G-code at layers.
    pub layer_gcode: Vec<LayerGcode>,
    /// Resume a print: the plate was sliced whole, and only layers from this
    /// one (0-based) are written, after a resume start sequence (heat, home X
    /// and Y but not Z, no purge line) instead of the normal start.
    pub resume_from_layer: Option<u32>,
    /// With a resume: write `G92 Z` to declare the nozzle height after homing X and Y.
    pub resume_z_mm: Option<f64>,
}

/// Writes G-code for `out`. The header is written when `out` covers layer 0
/// and the footer when it covers the last layer, so shard outputs concatenate
/// into the same bytes as a full run.
pub fn emit_gcode(
    out: &SliceOutput,
    config: &PrintConfig,
    flavor: GcodeFlavor,
    w: &mut impl Write,
) -> Result<GcodeStats> {
    emit_gcode_with(out, config, flavor, &EmitOptions::default(), w)
}

/// [`emit_gcode`] with [`EmitOptions`]. With `resume_from_layer`, the start
/// sequence is written by the output that contains that layer, layers below
/// it write nothing, and the stats count only what is written.
pub fn emit_gcode_with(
    out: &SliceOutput,
    config: &PrintConfig,
    flavor: GcodeFlavor,
    opts: &EmitOptions,
    w: &mut impl Write,
) -> Result<GcodeStats> {
    // The filament map the slice was planned with goes into the settings the G-code is written from
    // (the change G-code reads `filament_map`, the configuration block lists it).
    let mapped = out.filament_map.as_ref().map(|m| m.apply(config));
    let config = mapped.as_ref().unwrap_or(config);
    // Nothing leaves the engine that reaches off the bed, into an excluded area or over the height.
    let found = crate::preflight::check_toolpaths(out, config);
    if crate::preflight::blocks(&found) {
        return Err(crate::error::Error::Blocked(crate::preflight::blocking_text(
            &found,
        )));
    }
    let mut stats = GcodeStats::default();
    let tools = usize::from(out.tool_count.max(1));
    let mut e_total = vec![0i64; tools];
    let resume = opts.resume_from_layer.unwrap_or(0);
    let layers: Vec<&LayerPaths> = out.layers.iter().filter(|l| l.index >= resume).collect();
    if resume == 0 {
        if out.has_first_layer() {
            let h = header(out, config, flavor).map_err(custom_error)?;
            stats.bytes += h.len() as u64;
            w.write_all(&h)?;
        }
    } else if let Some(first) = layers.first().filter(|l| l.index == resume) {
        let h = resume_header(out, config, flavor, first, opts.resume_z_mm)?;
        stats.bytes += h.len() as u64;
        w.write_all(&h)?;
    }
    let shared = Shared::new(out, config);
    // A layer settling already wrote is read where it is, not copied: the file's bytes are held once.
    let chunks = par::map(&layers, |l| {
        let resume_first = l.index == resume && resume > 0;
        if let Some(w) = l.written.as_deref()
            && !resume_first
            && flavor == config.gcode_flavor
            && !opts.layer_gcode.iter().any(|g| g.layer == l.index)
        {
            return std::borrow::Cow::Borrowed(w);
        }
        std::borrow::Cow::Owned(emit_layer(
            l,
            out,
            config,
            flavor,
            resume_first,
            &opts.layer_gcode,
            &shared,
        ))
    });
    for (c, l) in chunks.iter().zip(&layers) {
        if let Some(e) = &c.error {
            return Err(custom_error(e.clone()));
        }
        w.write_all(&c.bytes)?;
        stats.bytes += c.bytes.len() as u64;
        stats.tool_changes += c.tool_changes;
        for (acc, e) in e_total.iter_mut().zip(&c.e_units) {
            *acc += e;
        }
        stats.time_s += f64::from(l.time_s) + c.change_time_s;
    }
    if out.has_last_layer() {
        let f = footer(out, config, flavor).map_err(custom_error)?;
        stats.bytes += f.len() as u64;
        w.write_all(&f)?;
    }
    #[allow(clippy::cast_precision_loss, reason = "extrusion totals stay far below 2^52")]
    {
        stats.filament_mm = e_total.iter().map(|&e| e as f64 / 1e5).collect();
    }
    let fil_area = std::f64::consts::PI * (config.filament_diameter / 2.0).m_powi(2);
    for (i, mm) in stats.filament_mm.iter().enumerate() {
        #[allow(clippy::cast_possible_truncation, reason = "slot index is small")]
        let slot = (i + 1) as u8;
        // mm of filament x cross-section in mm2 = mm3; / 1000 = cm3; x g/cm3 = g.
        let grams = mm * fil_area / 1000.0 * config.density(slot);
        stats.filament_g.push(grams);
        stats.cost += grams / 1000.0 * config.cost_per_kg(slot);
    }
    #[allow(clippy::cast_possible_truncation, reason = "layer counts fit in u32")]
    {
        stats.layers = layers.len() as u32;
    }
    Ok(stats)
}

fn header(out: &SliceOutput, base: &PrintConfig, flavor: GcodeFlavor) -> Result<Vec<u8>, String> {
    let mut b = Vec::with_capacity(2048);
    // Ultimaker's header comes first of all: the printer reads it before anything else.
    if flavor.is_ultimaker() {
        let (trains, bed) = ultimaker_trains(out, base);
        b.extend_from_slice(crate::griffin::header(base, flavor, &trains, bed).as_bytes());
    }
    // `file_start_gcode`: the very top of the file, before the header (Orca's `GCode::_do_export`).
    if crate::customgcode::text(base, "file_start_gcode").is_some_and(|t| !t.trim().is_empty())
        && let Some(t) =
            crate::customgcode::render(base, &crate::customgcode::context(base, out), "file_start_gcode")?
    {
        push_lines(&mut b, &t);
    }
    let lc = out.layers.first().map_or(base, |l| out.config_at(base, l.cfg));
    let temp = first_layer_temp(lc, 1);
    let first_slots = out
        .layers
        .first()
        .filter(|l| l.index == 0)
        .map(layer_slots)
        .unwrap_or_default();
    let initial_key = if lc.hot_plate_temp_initial_layer > 0.0 {
        "hot_plate_temp_initial_layer"
    } else {
        "hot_plate_temp"
    };
    let bed = bed_for(lc, initial_key, &first_slots, first_layer_bed(lc));
    if crate::firmware::bambu_printer(base, flavor) {
        bambu_blocks(&mut b, out, base, flavor, (temp, bed));
    } else {
        plain_header(&mut b, out, base, flavor);
    }
    let labels = crate::firmware::Labels::new(&out.objects, base, flavor);
    b.extend_from_slice(crate::firmware::thumbnail_marker(base).as_bytes());
    if crate::firmware::bambu_printer(base, flavor) {
        b.extend_from_slice(b"; EXECUTABLE_BLOCK_START\n");
    }
    // Where finalize writes the first progress line (Orca's `First_Line_M73_Placeholder`).
    b.extend_from_slice(b";@P\n");
    b.extend_from_slice(crate::firmware::machine_limits_lines(base, flavor).as_bytes());
    if let Some(labels) = labels {
        b.extend_from_slice(labels.header().as_bytes());
    }
    let mut ctx = crate::customgcode::context(base, out);
    ctx.set_num("layer_num", 0.0);
    ctx.set_num("layer_z", out.layers.first().map_or(0.0, |l| f64::from(l.z)));
    start_body(&mut b, out, base, flavor, &ctx, (lc, temp, bed))?;
    Ok(b)
}

/// The header block, the configuration block and the extrusion widths Orca writes for a Bambu Lab printer
/// (`GCode::_do_export`: `HEADER_BLOCK_START` to `CONFIG_BLOCK_END`; the firmware and Bambu Studio's
/// G-code parser read these). The estimated time line is a placeholder finalize fills.
fn bambu_blocks(
    b: &mut Vec<u8>,
    out: &SliceOutput,
    base: &PrintConfig,
    flavor: GcodeFlavor,
    first: (f64, f64),
) {
    let (temp, bed) = first;
    let c = base;
    b.extend_from_slice(b"; HEADER_BLOCK_START\n");
    let _ = writeln!(b, "; generated by SlicerX sx-core {}", env!("CARGO_PKG_VERSION"));
    write_notes(b, c);
    let _ = writeln!(b, "{}", crate::firmware::ESTIMATE_MARK);
    let _ = writeln!(b, "; total layer number: {}", out.layer_count);
    let labels = crate::firmware::Labels::new(&out.objects, base, flavor);
    if let Some(ids) = labels.as_ref().and_then(crate::firmware::Labels::id_list) {
        b.extend_from_slice(ids.as_bytes());
    }
    let tools = 1..=out.tool_count.max(1);
    let list = |f: &dyn Fn(u8) -> f64| {
        tools
            .clone()
            .map(|s| format!("{}", f(s)))
            .collect::<Vec<_>>()
            .join(",")
    };
    let _ = writeln!(b, "; filament_density: {}", list(&|s| c.density(s)));
    let _ = writeln!(b, "; filament_diameter: {}", list(&|_| c.filament_diameter));
    let _ = writeln!(b, "; max_z_height: {:.2}", out.plate_top_z);
    // The slots of every layer's paths, which finalize reads from the layer markers.
    let _ = writeln!(b, "{}", crate::firmware::FILAMENT_MARK);
    b.extend_from_slice(b"; HEADER_BLOCK_END\n\n; CONFIG_BLOCK_START\n");
    b.extend_from_slice(crate::firmware::config_lines(c).as_bytes());
    let _ = writeln!(b, "; first_layer_bed_temperature = {}", bed.round());
    let _ = writeln!(b, "; first_layer_temperature = {}", temp.round());
    b.extend_from_slice(b"; CONFIG_BLOCK_END\n\n");
    // line widths before the executable block, as `_do_export` lists them
    let _ = writeln!(
        b,
        "; external perimeters extrusion width = {:.2}mm",
        c.outer_wall_width()
    );
    let _ = writeln!(b, "; perimeters extrusion width = {:.2}mm", c.inner_wall_width());
    let _ = writeln!(b, "; infill extrusion width = {:.2}mm", c.sparse_infill_width());
    let _ = writeln!(
        b,
        "; solid infill extrusion width = {:.2}mm",
        c.solid_infill_width()
    );
    let _ = writeln!(b, "; top infill extrusion width = {:.2}mm", c.top_surface_width());
    if c.enable_support || c.raw_number("raft_layers", 0.0) > 0.0 {
        let _ = writeln!(
            b,
            "; support material extrusion width = {:.2}mm",
            c.support_width()
        );
    }
    if let Some(w) = c
        .feature_widths
        .initial_layer
        .filter(|_| c.raw_number("initial_layer_line_width", 0.0) > 0.0)
    {
        let _ = writeln!(b, "; first layer extrusion width = {w:.2}mm");
    }
    b.push(b'\n');
}

/// The header for every other printer: the generator, the person's notes and the main settings.
fn plain_header(b: &mut Vec<u8>, out: &SliceOutput, base: &PrintConfig, flavor: GcodeFlavor) {
    let c = base;
    let _ = writeln!(b, "; generated by SlicerX sx-core {}", env!("CARGO_PKG_VERSION"));
    let _ = writeln!(b, "; flavor: {flavor:?}");
    write_notes(b, c);
    let _ = writeln!(b, "; layer_height = {}", c.layer_height);
    let _ = writeln!(
        b,
        "; initial_layer_print_height = {}",
        c.initial_layer_print_height
    );
    let _ = writeln!(b, "; wall_loops = {}", c.wall_loops);
    let _ = writeln!(b, "; top_shell_layers = {}", c.top_shell_layers);
    let _ = writeln!(b, "; bottom_shell_layers = {}", c.bottom_shell_layers);
    let _ = writeln!(b, "; sparse_infill_density = {}%", c.sparse_infill_density);
    let _ = writeln!(b, "; line_width = {}", c.line_width);
    let _ = writeln!(b, "; brim_width = {}", c.brim_width);
    let _ = writeln!(b, "; total layer number: {}", out.layer_count);
    let labels = crate::firmware::Labels::new(&out.objects, base, flavor);
    if let Some(ids) = labels.as_ref().and_then(crate::firmware::Labels::id_list) {
        b.extend_from_slice(ids.as_bytes());
    }
}

/// `notes`: the person's own notes, as comments in the header. A stray carriage return or other control
/// character becomes a space, so no note can end its comment early and reach the printer as a command.
fn write_notes(b: &mut Vec<u8>, c: &PrintConfig) {
    if let Some(serde_json::Value::String(notes)) = c.raw.get("notes") {
        for line in notes.split('\n') {
            let line: String = line
                .chars()
                .map(|ch| if ch.is_control() { ' ' } else { ch })
                .collect();
            if !line.trim().is_empty() {
                let _ = writeln!(b, "; notes: {}", line.trim_end());
            }
        }
    }
}

/// The extruders an Ultimaker header and start list, the one that prints first first, with the temperature
/// each starts at (the first layer's for that one, standby for the rest), and the first layer's bed.
fn ultimaker_trains(out: &SliceOutput, base: &PrintConfig) -> (Vec<crate::griffin::Train>, f64) {
    let lc = out.layers.first().map_or(base, |l| out.config_at(base, l.cfg));
    let first = ultimaker_first_slot(out);
    let mut trains = vec![crate::griffin::Train {
        slot: first,
        initial: first_layer_temp(lc, first),
    }];
    for slot in (1..=out.tool_count.max(1)).filter(|&s| s != first) {
        trains.push(crate::griffin::Train {
            slot,
            initial: crate::griffin::standby(lc, slot, print_temp(lc, slot, 0)),
        });
    }
    let first_slots = out
        .layers
        .first()
        .filter(|l| l.index == 0)
        .map(layer_slots)
        .unwrap_or_default();
    let initial_key = if lc.hot_plate_temp_initial_layer > 0.0 {
        "hot_plate_temp_initial_layer"
    } else {
        "hot_plate_temp"
    };
    (
        trains,
        bed_for(lc, initial_key, &first_slots, first_layer_bed(lc)),
    )
}

/// The slot (1-based) of the first path the print makes.
fn ultimaker_first_slot(out: &SliceOutput) -> u8 {
    out.layers
        .iter()
        .find_map(|l| l.paths.first())
        .map_or(1, |p| p.tool.max(1))
}

/// The start of the print: the profile's start G-code (or a plain heat, home and wait), the filament's start
/// G-code, the extruder mode and pressure advance. `first` is the first layer's settings, nozzle and bed
/// temperatures.
fn start_body(
    b: &mut Vec<u8>,
    out: &SliceOutput,
    base: &PrintConfig,
    flavor: GcodeFlavor,
    ctx: &template::Context<'_>,
    first: (&PrintConfig, f64, f64),
) -> Result<(), String> {
    let (lc, temp, bed) = first;
    if flavor.is_ultimaker() {
        // Cura's start for the S series: the firmware heats, primes and wipes; nothing homes here.
        let (trains, _) = ultimaker_trains(out, lc);
        let own = crate::customgcode::render(base, ctx, "machine_start_gcode")?.unwrap_or_default();
        let first = trains.first().map_or(1, |t| t.slot);
        let mut tctx = ctx.clone();
        for k in ["current_extruder", "next_extruder"] {
            tctx.set_num(k, f64::from(first - 1));
        }
        let tool = crate::customgcode::render(base, &tctx, "extruder_start_gcode")?.unwrap_or_default();
        let mut text = crate::griffin::start(&trains, &own, &tool, bed, absolute_e_mode(base));
        // Then to the first core's switching position, where Cura starts the first layer from.
        if let Some([x, y]) = crate::griffin::point(
            lc,
            "toolchange_park_position",
            trains.first().map_or(1, |t| t.slot),
        ) {
            use std::fmt::Write as _;
            let _ = writeln!(
                text,
                "G0 F{} X{} Y{}",
                feed(initial_layer_travel_speed(lc)),
                crate::firmware::fmt_g(x),
                crate::firmware::fmt_g(y)
            );
        }
        b.extend_from_slice(text.as_bytes());
        return Ok(());
    }
    // orca turns the part and auxiliary fans off before the start when the first layers run without a fan
    let (first_id, _) = crate::customgcode::first_filaments(base, out);
    if crate::tower::flag(base, "auxiliary_fan")
        && crate::tower::per_slot_raw(base, "close_fan_the_first_x_layers", first_id + 1, 1.0) > 0.0
    {
        b.extend_from_slice(fan_cmd(flavor, 0).as_bytes());
        b.extend_from_slice(b"M106 P2 S0\n");
    }
    if let Some(start) = crate::customgcode::render(base, ctx, "machine_start_gcode")? {
        // The profile's own start: heat, home, purge. Temperatures are set up front
        // only when it does not do that itself.
        if !sets_temperature(&start) {
            let _ = writeln!(b, "M140 S{}", bed.round());
            temperature_line(b, flavor, temp.round(), false, None, "");
        }
        // Orca's Klipper profiles write the layer count in their own start G-code; do not repeat it.
        if flavor == GcodeFlavor::Klipper && !start.contains("SET_PRINT_STATS_INFO") {
            let _ = writeln!(b, "SET_PRINT_STATS_INFO TOTAL_LAYER={}", out.layer_count);
        }
        // the role tag orca writes ahead of the start g-code
        b.extend_from_slice(b";TYPE:Custom\n");
        b.extend_from_slice(start.as_bytes());
        if !start.ends_with('\n') {
            b.push(b'\n');
        }
        // the filament start of the first filament that is not support (orca's `initial_non_support_extruder_id`)
        let (first_id, solid_id) = crate::customgcode::first_filaments(base, out);
        let mut fctx = ctx.clone();
        fctx.extruder = usize::from(solid_id);
        if let Some(f) = crate::customgcode::render_slot(base, &fctx, "filament_start_gcode", solid_id + 1)? {
            b.extend_from_slice(f.as_bytes());
            if !f.ends_with('\n') {
                b.push(b'\n');
            }
        }
        // bambu firmware reads the first filament from this mark
        if crate::firmware::bambu_printer(base, flavor) {
            let _ = writeln!(b, ";VT{first_id}");
        }
        b.extend_from_slice(&e_mode_line(base, flavor));
    } else {
        let _ = writeln!(b, "M140 S{}", bed.round());
        temperature_line(b, flavor, temp.round(), false, None, "");
        if flavor == GcodeFlavor::Klipper {
            let _ = writeln!(b, "SET_PRINT_STATS_INFO TOTAL_LAYER={}", out.layer_count);
        }
        b.extend_from_slice(b"G28\n");
        let _ = writeln!(b, "M190 S{}", bed.round());
        temperature_line(b, flavor, temp.round(), true, None, "");
        b.extend_from_slice(&e_mode_line(base, flavor));
        b.extend_from_slice(fan_cmd(flavor, 0).as_bytes());
    }
    for slot in 1..=out.tool_count.max(1) {
        let pa = lc.pressure_advance_for(slot);
        if pa > 0.0 {
            pressure_advance(b, flavor, slot, pa);
        }
    }
    // orca opens the spaghetti detector before the first layer, whatever the detector setting
    if crate::firmware::bambu_printer(base, flavor) {
        b.extend_from_slice(b"M981 S1 P20000 ;open spaghetti detector\n");
    }
    Ok(())
}

/// True when a template sets nozzle or bed temperature itself.
fn sets_temperature(t: &str) -> bool {
    ["M104", "M109", "M140", "M190"].iter().any(|c| t.contains(c))
}

/// Nozzle temperature of the first layer for a slot: its own setting, or the usual one.
fn first_layer_temp(c: &PrintConfig, slot: u8) -> f64 {
    let list = if c.nozzle_temperature_initial_layer.is_empty() {
        &c.nozzle_temperature
    } else {
        &c.nozzle_temperature_initial_layer
    };
    PrintConfig::per_slot(list, slot, 220.0)
}

fn first_layer_bed(c: &PrintConfig) -> f64 {
    if c.hot_plate_temp_initial_layer > 0.0 {
        c.hot_plate_temp_initial_layer
    } else {
        c.hot_plate_temp
    }
}

/// Part cooling fan for a layer, 0 to 255 (Orca's `CoolingBuffer::apply_layer_cooldown`). Layers faster
/// than `slow_down_layer_time` run at the maximum, those up to `fan_cooling_layer_time` between the two
/// in whole percents, and slower ones stop the fan unless `reduce_fan_stop_start_freq` (per filament)
/// keeps it at the minimum.
fn layer_fan(c: &PrintConfig, index: u32, time_s: f32, slot: u8) -> i64 {
    if index < c.close_fan_the_first_x_layers {
        return 0;
    }
    let t = f64::from(time_s);
    let (lo, hi) = (c.slow_down_layer_time, c.fan_cooling_layer_time);
    let pct = if t < lo {
        c.fan_max_speed
    } else if t < hi {
        // orca floors the blend as is, so equal ends can lose a percent to rounding noise; we don't
        let r = (t - lo) / (hi - lo);
        (r * c.fan_min_speed + (1.0 - r) * c.fan_max_speed + 1e-9).floor()
    } else if crate::tower::slot_flag(c, "reduce_fan_stop_start_freq", slot) {
        c.fan_min_speed
    } else {
        0.0
    };
    let pct = fan_ramp(c, index).map_or(pct, |f| (pct * f + 0.5).floor());
    fan_pwm(c, pct)
}

/// The auxiliary fan of a layer for a slot, 0 to 255, on a printer with one (`auxiliary_fan`): off for the first
/// `close_fan_the_first_x_layers`, then `additional_cooling_fan_speed` (Orca's `change_extruder_set_fan` and
/// `GCodeWriter::set_additional_fan`).
fn aux_fan(c: &PrintConfig, index: u32, slot: u8) -> Option<i64> {
    if !crate::tower::flag(c, "auxiliary_fan") {
        return None;
    }
    let closed = crate::tower::per_slot_raw(c, "close_fan_the_first_x_layers", slot, 1.0);
    let pct = if f64::from(index) >= closed {
        crate::tower::per_slot_raw(c, "additional_cooling_fan_speed", slot, 0.0).trunc()
    } else {
        0.0
    };
    #[allow(clippy::cast_possible_truncation, reason = "a percentage of 255")]
    Some((255.0 * pct / 100.0) as i64)
}

/// A fan percentage as Orca's `GCodeWriter::set_fan` writes it: whole percents, a nonzero speed raised to
/// `part_cooling_fan_min_pwm`, then 255.5 per hundred cut to an integer.
fn fan_pwm(c: &PrintConfig, pct: f64) -> i64 {
    let mut p = pct.clamp(0.0, 100.0).trunc();
    let least = c.raw_number("part_cooling_fan_min_pwm", 0.0).clamp(0.0, 100.0);
    if p > 0.0 && p < least {
        p = least;
    }
    #[allow(clippy::cast_possible_truncation, reason = "a percentage of 255")]
    {
        (255.5 * p / 100.0) as i64
    }
}

/// `full_fan_speed_layer`: from `close_fan_the_first_x_layers` the fan speeds (the layer's and the overhang
/// fan's) climb to full by that layer, 1-based (Orca's `CoolingBuffer::apply_layer_cooldown`); the share of
/// full speed on layer `index`, or None outside the climb.
fn fan_ramp(c: &PrintConfig, index: u32) -> Option<f64> {
    let full = c.raw_number("full_fan_speed_layer", 0.0);
    let close = f64::from(c.close_fan_the_first_x_layers);
    let at = f64::from(index);
    (at >= close && at + 1.0 < full).then(|| (at + 1.0 - close) / (full - close))
}

/// `bed_temperature_formula` `by_highest_temp`: the bed takes the highest bed temperature of the filaments the
/// layer prints (`key` a per-filament list), as Orca's `get_highest_bed_temperature` does; otherwise, or
/// without such a list, `fallback`.
fn bed_for(c: &PrintConfig, key: &str, slots: &[u8], fallback: f64) -> f64 {
    let highest = matches!(c.raw.get("bed_temperature_formula"), Some(serde_json::Value::String(f)) if f == "by_highest_temp");
    let list: Vec<f64> = match c.raw.get(key) {
        Some(serde_json::Value::Array(a)) => a
            .iter()
            .filter_map(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|t| t.trim().parse().ok()))
            })
            .collect(),
        _ => Vec::new(),
    };
    if !highest || list.is_empty() || slots.is_empty() {
        return fallback;
    }
    slots
        .iter()
        .map(|&s| PrintConfig::per_slot(&list, s, fallback))
        .fold(f64::MIN, f64::max)
}

/// `overhang_fan_threshold` at 0%: the overhang fan runs on every outer wall.
fn overhang_fan_on_walls(c: &PrintConfig) -> bool {
    let v = match c.raw.get("overhang_fan_threshold") {
        Some(serde_json::Value::Array(a)) => a.first(),
        other => other,
    };
    matches!(v, Some(serde_json::Value::String(t)) if t.trim() == "0%")
}

/// The filament slots a layer prints, in order of first use.
fn layer_slots(l: &LayerPaths) -> Vec<u8> {
    let mut v: Vec<u8> = Vec::new();
    for p in &l.paths {
        let t = p.tool.max(1);
        if !v.contains(&t) {
            v.push(t);
        }
    }
    v
}

/// How far a resumed print lifts the nozzle before homing X and Y, mm.
const RESUME_LIFT_MM: f64 = 5.0;

/// One nozzle temperature line the way `GCodeWriter::set_temperature` writes it: `M104` (or `M109` to wait, `G10`
/// on `RepRapFirmware`), `S` (`P` on Mach3 and Machinekit), then the tool as ` T` (` P` on `RepRapFirmware`), and an
/// `M116` after a wait on Teacup and `RepRapFirmware`; `MakerWare` and `Sailfish` cannot wait. `suffix` ends the line.
fn temperature_line(
    b: &mut Vec<u8>,
    flavor: GcodeFlavor,
    temp: f64,
    wait: bool,
    tool: Option<u8>,
    suffix: &str,
) {
    if wait && matches!(flavor, GcodeFlavor::MakerWare | GcodeFlavor::Sailfish) {
        return;
    }
    let code = if wait && !matches!(flavor, GcodeFlavor::Teacup | GcodeFlavor::RepRapFirmware) {
        "M109"
    } else if flavor == GcodeFlavor::RepRapFirmware {
        "G10"
    } else {
        "M104"
    };
    let letter = if matches!(flavor, GcodeFlavor::Mach3 | GcodeFlavor::Machinekit) {
        'P'
    } else {
        'S'
    };
    if flavor.is_ultimaker() {
        // CuraEngine's order: the tool before the temperature.
        b.extend_from_slice(code.as_bytes());
        if let Some(t) = tool {
            let _ = write!(b, " T{t}");
        }
        let _ = writeln!(b, " S{temp}{suffix}");
        return;
    }
    let mut line = format!("{code} {letter}{temp}");
    if let Some(t) = tool {
        line.push_str(if flavor == GcodeFlavor::RepRapFirmware {
            " P"
        } else {
            " T"
        });
        line.push_str(&t.to_string());
    }
    line.push_str(suffix);
    line.push('\n');
    b.extend_from_slice(line.as_bytes());
    if wait && matches!(flavor, GcodeFlavor::Teacup | GcodeFlavor::RepRapFirmware) {
        b.extend_from_slice(b"M116 ; wait for temperature to be reached\n");
    }
}

/// Sets the temperature of a tool that is not the active one (no wait).
fn resume_tool_temp(b: &mut Vec<u8>, flavor: GcodeFlavor, slot: u8, temp: f64) {
    let t = temp.round();
    if flavor == GcodeFlavor::Klipper {
        let _ = writeln!(b, "SET_HEATER_TEMPERATURE HEATER=extruder{} TARGET={t}", slot - 1);
    } else {
        temperature_line(b, flavor, t, false, Some(slot - 1), "");
    }
}

/// Ooze prevention (`ooze_prevention`, not with a single extruder for several filaments): idle
/// tools wait at a standby temperature (`idle_temperature`, else the print temperature plus
/// `standby_temperature_delta`) and come back to temperature after a tool change (Orca's
/// `OozePrevention`).
fn ooze_prevention(c: &PrintConfig) -> bool {
    crate::tower::flag(c, "ooze_prevention")
        && !crate::tower::flag_or(c, "single_extruder_multi_material", true)
}

/// The temperature `slot` prints at on layer `index`.
fn print_temp(c: &PrintConfig, slot: u8, index: u32) -> f64 {
    let usual = PrintConfig::per_slot(&c.nozzle_temperature, slot, 220.0);
    if index == 0 || usual <= 0.0 {
        first_layer_temp(c, slot)
    } else {
        usual
    }
}

/// `M104`/`M109` for one tool, as Orca's writer (`temperature_line`).
fn tool_temp(b: &mut Vec<u8>, flavor: GcodeFlavor, slot: u8, temp: f64, wait: bool, comment: &str) {
    temperature_line(
        b,
        flavor,
        temp.round(),
        wait,
        Some(slot.max(1) - 1),
        &format!(" ;{comment}"),
    );
}

/// One `M104` for tool `tool` (zero-based) as Orca's `GCodeWriter::set_temperature` writes it with a comment:
/// `M104 S220 T1 ; comment` (`G10 S220 P1` on `RepRapFirmware`).
pub(crate) fn orca_temperature_line(
    b: &mut Vec<u8>,
    flavor: GcodeFlavor,
    tool: usize,
    temp: f64,
    comment: &str,
) {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a nozzle temperature"
    )]
    let t = temp.max(0.0) as u32;
    #[allow(clippy::cast_possible_truncation, reason = "a tool index is small")]
    temperature_line(
        b,
        flavor,
        f64::from(t),
        false,
        Some(tool as u8),
        &format!(" ; {comment}"),
    );
}

/// The standby temperature of `slot` on layer `index`, when ooze prevention sets one.
fn standby_temp(c: &PrintConfig, slot: u8, index: u32) -> Option<f64> {
    let idle = crate::tower::per_slot_raw(c, "idle_temperature", slot, 0.0);
    if idle > 0.0 {
        return Some(idle);
    }
    let delta = c.raw_number("standby_temperature_delta", -5.0);
    (delta != 0.0).then(|| print_temp(c, slot, index) + delta)
}

/// The tool change command (`toolchange_prefix`): `MakerWare` and Sailfish name it differently.
fn toolchange_prefix(flavor: GcodeFlavor) -> &'static str {
    match flavor {
        GcodeFlavor::MakerWare => "M135 T",
        GcodeFlavor::Sailfish => "M108 T",
        _ => "T",
    }
}

/// True when custom G-code selects tool `next` itself (Orca's `custom_gcode_changes_tool`): the last
/// `prefix` that starts a line (after blanks) is followed by `next`.
pub(crate) fn changes_tool(text: &str, prefix: &str, next: i64) -> bool {
    let mut ok = false;
    for line in text.lines() {
        let Some(rest) = line.trim_start().strip_prefix(prefix) else {
            continue;
        };
        let digits: String = rest
            .trim_start()
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if let Ok(n) = digits.parse::<i64>() {
            ok = n == next;
        }
    }
    ok
}

/// The seconds a printer spends on each filament change beyond its moves, kept across the print the
/// way Orca's G-code processor keeps them (2.4.2 `GCodeProcessor::process_T`, Bambu Studio
/// `process_filament_change`): which filament sits in each extruder (`filament_map`, 1-based
/// extruder per filament), so that a change to another filament on the same extruder costs an
/// unload and a load, a change to another extruder costs the switch (`machine_tool_change_time`,
/// or Bambu's name for it, `machine_switch_extruder_time`), plus a load when that extruder is
/// empty or an unload and a load when it last held a different filament. As in Orca, the first
/// unload of the print is free (`extruder_unloaded`).
#[derive(Clone, Debug)]
pub(crate) struct ChangeClock {
    map: Vec<usize>,
    extruder: Option<usize>,
    filament_of: Vec<Option<usize>>,
    unloaded: bool,
    switch: f64,
    load: f64,
    unload: f64,
}

impl ChangeClock {
    pub(crate) fn new(c: &PrintConfig) -> Self {
        let num = |v: &serde_json::Value| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|t| t.trim().parse().ok()))
        };
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "extruder numbers are small"
        )]
        let map: Vec<usize> = match c.raw.get("filament_map") {
            Some(serde_json::Value::Array(a)) => a
                .iter()
                .filter_map(num)
                .map(|v| (v.round().max(1.0) as usize) - 1)
                .collect(),
            _ => Vec::new(),
        };
        Self::with_map(c, map)
    }

    /// The clock for a candidate filament map: the extruder (0-based) of each filament.
    pub(crate) fn with_map(c: &PrintConfig, map: Vec<usize>) -> Self {
        let nozzles = match c.raw.get("nozzle_diameter") {
            Some(serde_json::Value::Array(a)) => a.len(),
            _ => 1,
        };
        let switch = match c.raw.get("machine_tool_change_time") {
            Some(_) => c.raw_number("machine_tool_change_time", 0.0),
            None => c.raw_number("machine_switch_extruder_time", 0.0),
        };
        Self {
            map,
            extruder: None,
            filament_of: vec![None; nozzles.max(1)],
            unloaded: true,
            switch: switch.max(0.0),
            load: c.raw_number("machine_load_filament_time", 0.0).max(0.0),
            unload: c.raw_number("machine_unload_filament_time", 0.0).max(0.0),
        }
    }

    /// The state mid print: `tool` (1-based) active, and with a filament map the filament each nozzle
    /// holds (`held`, 1-based, 0 for none).
    pub(crate) fn seed(&mut self, tool: u8, held: &[u8], map: Option<&crate::nozzles::Map>) {
        let f = usize::from(tool.max(1) - 1);
        if let Some(map) = map {
            for &h in held.iter().filter(|&&h| h != 0) {
                let e = map.extruder_of(h).min(self.filament_of.len().saturating_sub(1));
                if let Some(s) = self.filament_of.get_mut(e) {
                    *s = Some(usize::from(h - 1));
                }
            }
        }
        let e = self.extruder_of(f);
        if let Some(s) = self.filament_of.get_mut(e) {
            *s = Some(f);
        }
        self.extruder = Some(e);
        self.unloaded = false;
    }

    /// The extruder (0-based) that prints filament `f` (0-based): its `filament_map` entry, else
    /// one extruder per filament on a tool changer, else the one nozzle.
    fn extruder_of(&self, f: usize) -> usize {
        let n = self.filament_of.len();
        self.map
            .get(f)
            .copied()
            .unwrap_or(if n > 1 { f } else { 0 })
            .min(n - 1)
    }

    /// Seconds the firmware spends switching to filament `next` (0-based), and the new state.
    pub(crate) fn change(&mut self, next: usize) -> f64 {
        let e = self.extruder_of(next);
        let prev = self.extruder;
        let held = prev.and_then(|p| self.filament_of.get(p).copied().flatten());
        if held == Some(next) {
            return 0.0;
        }
        let mut t = 0.0;
        let mut load = |clock: &mut Self, unload_first: bool| {
            if unload_first && !clock.unloaded {
                t += clock.unload;
            }
            clock.unloaded = false;
            t += clock.load;
            if let Some(s) = clock.filament_of.get_mut(e) {
                *s = Some(next);
            }
        };
        match prev {
            Some(p) if p == e => load(self, true),
            None => {
                self.extruder = Some(e);
                load(self, false);
            }
            Some(_) => {
                self.extruder = Some(e);
                match self.filament_of.get(e).copied().flatten() {
                    None => load(self, false),
                    Some(f) if f != next => load(self, true),
                    Some(_) => {}
                }
                t += self.switch;
            }
        }
        t
    }
}

/// The fixed seconds of every counted change of every layer, in print order, from one
/// [`ChangeClock`] run over the whole print: `[layer index][change number in the layer]`. A change
/// is counted where the layer writer counts one (the path's tool differs from the tool in the
/// nozzle, which the layer's first path sets without a change when nothing is loaded yet).
fn change_times(out: &SliceOutput, c: &PrintConfig) -> Vec<Vec<f64>> {
    let mut clock = ChangeClock::new(c);
    // An output that starts mid print (a shard) starts with what the nozzles hold there, so its changes
    // cost what they cost in the whole print.
    if let Some(first) = out.layers.first().filter(|l| l.start_tool != 0) {
        clock.seed(first.start_tool, &first.held_before, out.filament_map.as_ref());
    }
    let mut tool = 0u8;
    out.layers
        .iter()
        .map(|l| {
            if l.start_tool != 0 {
                tool = l.start_tool;
            }
            let mut v = Vec::new();
            for p in &l.paths {
                if p.tool != tool {
                    if tool != 0 {
                        v.push(clock.change(usize::from(p.tool.max(1) - 1)));
                    } else {
                        clock.change(usize::from(p.tool.max(1) - 1));
                    }
                    tool = p.tool;
                }
            }
            v
        })
        .collect()
}

/// Seconds a tool change takes beyond the print moves: `fixed` from the [`ChangeClock`] (when the
/// prepass has an entry for this change, else the stateless rule: unload and load on one nozzle,
/// the switch time on more), plus the moves and dwells of the change G-code written for it
/// (`text`). `start` is where the nozzle is (X, Y) and `z` its height.
fn tool_change_time(
    c: &PrintConfig,
    fixed: Option<f64>,
    text: &[u8],
    start: Option<[f64; 2]>,
    z: f64,
) -> f64 {
    let fixed = fixed.unwrap_or_else(|| {
        let mut clock = ChangeClock::new(c);
        if clock.filament_of.len() > 1 {
            clock.switch
        } else {
            clock.change(0);
            clock.unloaded = false;
            clock.change(1)
        }
    });
    fixed.max(0.0) + gcode_text_time(c, text, start, z)
}

/// Seconds to run a piece of G-code: its G0/G1/G2/G3 moves through the motion model (straight
/// lines for arcs), and its `G4` dwells. Positions start at `start`, absolute unless `G91`.
fn gcode_text_time(c: &PrintConfig, text: &[u8], start: Option<[f64; 2]>, z: f64) -> f64 {
    let text = String::from_utf8_lossy(text);
    let lim = crate::motion::Limits::from_config(c);
    let accel = crate::motion::travel_accel(c);
    let r_accel = crate::motion::retract_accel(c);
    let mut pos = [start.map_or(0.0, |p| p[0]), start.map_or(0.0, |p| p[1]), z];
    let (mut relative, mut feed) = (false, c.travel_speed.max(1.0));
    let mut moves: Vec<crate::motion::Move> = Vec::new();
    let mut dwell = 0.0;
    let run = |moves: &mut Vec<crate::motion::Move>| -> f64 {
        if moves.is_empty() {
            return 0.0;
        }
        let t = match &lim {
            Some(l) => crate::motion::time(moves, l),
            None => moves
                .iter()
                .map(|m| {
                    let d = m.d.iter().map(|v| v * v).sum::<f64>().sqrt();
                    d / m.feed.max(0.1)
                })
                .sum(),
        };
        moves.clear();
        t
    };
    for line in text.lines() {
        let code = line.split(';').next().unwrap_or("").trim();
        let mut words = code.split_ascii_whitespace();
        let Some(cmd) = words.next() else { continue };
        let arg = |w: &str, k: char| w.strip_prefix(k).and_then(|v| v.parse::<f64>().ok());
        match cmd {
            "G90" => relative = false,
            "G91" => relative = true,
            "G4" | "M400" => {
                // Orca's processor waits `S` seconds plus `P` milliseconds on both.
                dwell += run(&mut moves);
                for w in words {
                    if let Some(v) = arg(w, 'S') {
                        dwell += v;
                    } else if let Some(v) = arg(w, 'P') {
                        dwell += v / 1000.0;
                    }
                }
            }
            "G0" | "G1" | "G2" | "G3" => {
                let mut d = [0.0f64; 4];
                for w in words {
                    for (i, k) in ['X', 'Y', 'Z'].iter().enumerate() {
                        if let (Some(v), Some(p)) = (arg(w, *k), pos.get_mut(i)) {
                            let to = if relative { *p + v } else { v };
                            if let Some(slot) = d.get_mut(i) {
                                *slot = to - *p;
                            }
                            *p = to;
                        }
                    }
                    if let Some(v) = arg(w, 'E') {
                        d[3] = v;
                    }
                    if let Some(v) = arg(w, 'F') {
                        feed = (v / 60.0).max(0.1);
                    }
                }
                if d.iter().any(|v| v.abs() > 1e-9) {
                    let e_only = d[0].abs() + d[1].abs() + d[2].abs() < 1e-9;
                    moves.push(crate::motion::Move {
                        d,
                        feed,
                        accel: if e_only { r_accel } else { accel },
                        jerk_xy: 0.0,
                    });
                }
            }
            _ => {}
        }
    }
    dwell + run(&mut moves)
}

/// The start of a resumed print. The plate was sliced whole, so walls and
/// infill line up with what is already on the bed. Heats, homes X and Y, and
/// does not home Z or draw a purge line. Z is left as the printer has it: the
/// first layer chunk moves to an absolute Z, so the printer must know its Z
/// (motors still on, or set by the host) before this starts.
fn resume_header(
    out: &SliceOutput,
    base: &PrintConfig,
    flavor: GcodeFlavor,
    first: &LayerPaths,
    declare_z: Option<f64>,
) -> Result<Vec<u8>, crate::error::Error> {
    let mut b = Vec::with_capacity(512);
    let lc = out.config_at(base, first.cfg);
    // The tool that is active when the resumed layer starts (0 means the first).
    let active = first.start_tool.max(1);
    let temp = PrintConfig::per_slot(&lc.nozzle_temperature, active, 220.0);
    let bed = lc.hot_plate_temp;
    let bottom = f64::from(first.z) - f64::from(first.height);
    let _ = writeln!(b, "; generated by SlicerX sx-core {}", env!("CARGO_PKG_VERSION"));
    let _ = writeln!(b, "; flavor: {flavor:?}");
    let _ = writeln!(
        b,
        "; resume from layer {} of {} (0-based {}), print surface at Z{:.3}",
        first.index + 1,
        out.layer_count,
        first.index,
        bottom
    );
    let _ = writeln!(b, "; total layer number: {}", out.layer_count);
    let _ = writeln!(b, "M140 S{}", bed.round());
    temperature_line(&mut b, flavor, temp.round(), false, None, "");
    // Every other tool the plate uses heats to its own temperature too.
    for slot in 1..=out.tool_count.max(1) {
        if slot != active {
            resume_tool_temp(
                &mut b,
                flavor,
                slot,
                PrintConfig::per_slot(&lc.nozzle_temperature, slot, 220.0),
            );
        }
    }
    if flavor == GcodeFlavor::Klipper {
        let _ = writeln!(b, "SET_PRINT_STATS_INFO TOTAL_LAYER={}", out.layer_count);
    }
    // Homing X and Y with the nozzle low drags it through the failed part, so lift
    // first, by a relative move that needs the printer to know its Z. A declared Z
    // is set before the lift, since the nozzle really is at that height.
    let mut headroom = RESUME_LIFT_MM;
    if let Some(z) = declare_z {
        let _ = writeln!(
            b,
            "; Z is declared, not homed: the nozzle must be at Z{z:.3} by hand before this starts"
        );
        if flavor == GcodeFlavor::Klipper {
            let _ = writeln!(b, "SET_KINEMATIC_POSITION Z={z:.3}");
        } else {
            let _ = writeln!(b, "G92 Z{z:.3}");
        }
        headroom = headroom.min((base.printable_height - z).max(0.0));
    }
    if headroom > 0.0 {
        let _ = writeln!(
            b,
            "; lift before homing X and Y\nG91\nG1 Z{headroom:.1} F600\nG90"
        );
    }
    // The profile's own start, made safe for a resume, when it has one that can be
    // (a firmware macro cannot): it homes X and Y and heats, as the built-in lines do.
    let mut ctx = crate::customgcode::context(base, out);
    ctx.set_num("layer_num", f64::from(first.index));
    ctx.set_num("layer_z", f64::from(first.z));
    if let Some(start) = crate::customgcode::resume_start(base, &ctx, bottom).map_err(custom_error)? {
        {
            b.extend_from_slice(b"; profile start G-code, without homing Z, probing or purging\n");
            push_lines(&mut b, &start);
            if !sets_temperature(&start) {
                let _ = writeln!(b, "M190 S{}", bed.round());
                temperature_line(&mut b, flavor, temp.round(), true, None, "");
            }
        }
    } else {
        {
            b.extend_from_slice(b"G28 X Y\n");
            let _ = writeln!(b, "M190 S{}", bed.round());
            temperature_line(&mut b, flavor, temp.round(), true, None, "");
        }
    }
    b.extend_from_slice(&e_mode_line(base, flavor));
    b.extend_from_slice(fan_cmd(flavor, 0).as_bytes());
    for slot in 1..=out.tool_count.max(1) {
        let pa = lc.pressure_advance_for(slot);
        if pa > 0.0 {
            pressure_advance(&mut b, flavor, slot, pa);
        }
    }
    Ok(b)
}

/// Sets pressure advance for a 1-based slot in the flavor's own command.
fn pressure_advance(b: &mut Vec<u8>, flavor: GcodeFlavor, slot: u8, value: f64) {
    let scaled = e_units(value);
    match flavor {
        GcodeFlavor::Klipper => {
            b.extend_from_slice(b"SET_PRESSURE_ADVANCE ADVANCE=");
            put_fixed(b, scaled, 5);
            if slot > 1 {
                b.extend_from_slice(b" EXTRUDER=extruder");
                put_int(b, i64::from(slot - 1));
            }
        }
        GcodeFlavor::RepRapFirmware => {
            b.extend_from_slice(b"M572 D");
            put_int(b, i64::from(slot - 1));
            b.extend_from_slice(b" S");
            put_fixed(b, scaled, 5);
        }
        GcodeFlavor::Repetier => {
            // Repetier's M233: X is the quadratic term, Y the linear; both take the value.
            b.extend_from_slice(b"M233 X");
            put_fixed(b, scaled, 5);
            b.extend_from_slice(b" Y");
            put_fixed(b, scaled, 5);
        }
        _ => {
            b.extend_from_slice(b"M900 K");
            put_fixed(b, scaled, 5);
            if slot > 1 {
                b.extend_from_slice(b" T");
                put_int(b, i64::from(slot - 1));
            }
        }
    }
    b.push(b'\n');
}

/// The end sequence followed by the marker that [`crate::firmware::finalize`] turns into
/// the statistics footer.
fn footer(out: &SliceOutput, c: &PrintConfig, flavor: GcodeFlavor) -> Result<Vec<u8>, String> {
    let mut b = footer_body(out, c, flavor)?;
    b.extend_from_slice(
        crate::firmware::footer_marker(c, out.tool_count, out.layer_count, flavor).as_bytes(),
    );
    Ok(b)
}

fn footer_body(out: &SliceOutput, c: &PrintConfig, flavor: GcodeFlavor) -> Result<Vec<u8>, String> {
    let mut b = Vec::with_capacity(256);
    let top = out.layers.last().map_or(0.0, |l| f64::from(l.z));
    let park = (top + 10.0).min(c.printable_height.max(top));
    b.extend_from_slice(b"; end\n");
    if absolute_e_mode(c) {
        // The layers are absolute from their own reset; so is the closing retract.
        b.extend_from_slice(e_reset_line(flavor));
    }
    // The last filament's own retraction, when it overrides the printer's.
    let last_tool = out
        .layers
        .iter()
        .rev()
        .find_map(|l| l.paths.last())
        .map_or(1, |p| p.tool.max(1));
    let rc = c.for_filament(last_tool);
    let style = Retraction::of(c, flavor);
    // orca's closing retract wipes along the last path too
    let tail = out.layers.last().map(LayerPaths::wipe_tail).unwrap_or_default();
    if rc.retraction_length > 0.0
        && rc.wipe
        && !style.firmware
        && let Some(&at) = tail.points.last()
    {
        let speed = if tail.speed_mm_s > 0.0 {
            feed(f64::from(tail.speed_mm_s))
        } else {
            -1
        };
        retract_wiping(
            &mut b,
            style,
            (&rc, c),
            (at, &tail.points, tail.forward),
            (e_units(rc.retraction_length), feed(rc.retraction_speed)),
            speed,
        );
    } else if rc.retraction_length > 0.0 {
        b.extend_from_slice(b"G1 E-");
        put_fixed(&mut b, e_units(rc.retraction_length), 5);
        b.extend_from_slice(b" F");
        put_int(&mut b, feed(rc.retraction_speed));
        b.push(b'\n');
    }
    let mut ctx = crate::customgcode::context(c, out);
    ctx.set_num("layer_num", f64::from(out.layer_count.saturating_sub(1)));
    ctx.set_num("layer_z", top);
    // the end reads the filament in the nozzle
    ctx.set_num("current_extruder", f64::from(last_tool - 1));
    ctx.extruder = usize::from(last_tool - 1);
    if flavor.is_ultimaker() {
        // Cura's end: the firmware parks the head and cools the nozzles itself.
        let end = crate::customgcode::render(c, &ctx, "machine_end_gcode")?.unwrap_or_default();
        b.extend_from_slice(crate::griffin::end(&end, absolute_e_mode(c)).as_bytes());
        postamble(&mut b, c, flavor);
        return Ok(b);
    }
    if let Some(end) = crate::customgcode::render(c, &ctx, "machine_end_gcode")? {
        // Orca turns the part fan off before the profile's end G-code.
        b.extend_from_slice(fan_cmd(flavor, 0).as_bytes());
        if crate::tower::flag(c, "auxiliary_fan") {
            b.extend_from_slice(b"M106 P2 S0\n");
        }
        // bambu firmware takes m981 s0 as the last layer done, whatever the detector setting
        if crate::firmware::bambu_printer(c, flavor) {
            b.extend_from_slice(b"M981 S0 P20000 ; close spaghetti detector\n");
        }
        b.extend_from_slice(b";TYPE:Custom\n");
        // orca's end runs the filament end of the filament in the nozzle on a shared nozzle, else of every one
        let ends: Vec<u8> = if crate::tower::flag(c, "single_extruder_multi_material") {
            vec![last_tool]
        } else {
            (1..=out.tool_count.max(1)).collect()
        };
        for slot in ends {
            let mut fctx = ctx.clone();
            fctx.set_num("filament_extruder_id", f64::from(slot - 1));
            fctx.extruder = usize::from(slot - 1);
            if let Some(f) = crate::customgcode::render_slot(c, &fctx, "filament_end_gcode", slot)? {
                b.extend_from_slice(f.as_bytes());
                if !f.ends_with('\n') {
                    b.push(b'\n');
                }
            }
        }
        b.extend_from_slice(end.as_bytes());
        if !end.ends_with('\n') {
            b.push(b'\n');
        }
        postamble(&mut b, c, flavor);
        return Ok(b);
    }
    b.extend_from_slice(b"G1 Z");
    #[allow(clippy::cast_possible_truncation, reason = "z in thousandths fits in i64")]
    put_fixed(&mut b, (park * 1000.0).round() as i64, 3);
    b.extend_from_slice(b" F600\n");
    temperature_line(&mut b, flavor, 0.0, false, None, "");
    b.extend_from_slice(b"M140 S0\n");
    b.extend_from_slice(match flavor {
        GcodeFlavor::MakerWare | GcodeFlavor::Sailfish => b"M127\n".as_slice(),
        _ => b"M107\n".as_slice(),
    });
    b.extend_from_slice(b"M84\n");
    postamble(&mut b, c, flavor);
    Ok(b)
}

/// What Orca writes after the end G-code: the 100 percent progress line of `MakerWare` and `Sailfish`
/// (`GCodeWriter::update_progress`) and Machinekit's end of program (`GCodeWriter::postamble`).
fn postamble(b: &mut Vec<u8>, c: &PrintConfig, flavor: GcodeFlavor) {
    if progress_flavor(c, flavor) {
        b.extend_from_slice(b"M73 P100\n");
    }
    if flavor == GcodeFlavor::Machinekit {
        b.extend_from_slice(b"M2 ; end of program\n");
    }
}

/// `GCode::change_layer`'s progress line: `M73 P`, the layer's index over the layer count, rounded, below 100.
fn layer_progress(b: &mut Vec<u8>, c: &PrintConfig, flavor: GcodeFlavor, index: u32, count: u32) {
    if progress_flavor(c, flavor) && count > 0 {
        let pct = ((100.0 * f64::from(index) / f64::from(count)) + 0.5)
            .floor()
            .min(99.0);
        let _ = writeln!(b, "M73 P{pct}");
    }
}

/// The last filament a block of G-code selects: its last line that is `T` and a number under 255
/// (Bambu's `T255` and `T1000` select none), zero-based.
fn last_filament(text: &str) -> Option<u8> {
    text.lines()
        .rev()
        .filter_map(|l| l.trim().strip_prefix('T')?.trim().parse::<u32>().ok())
        .find(|n| *n < 255)
        .and_then(|n| u8::try_from(n).ok())
}

/// `MakerWare` and `Sailfish` get a progress percentage at each layer change unless `disable_m73` is on.
fn progress_flavor(c: &PrintConfig, flavor: GcodeFlavor) -> bool {
    matches!(flavor, GcodeFlavor::MakerWare | GcodeFlavor::Sailfish)
        && !crate::firmware::truthy(c, "disable_m73")
}

#[allow(clippy::cast_possible_truncation, reason = "feedrates are small")]
fn feed(mm_s: f64) -> i64 {
    (mm_s * 60.0).round() as i64
}

#[allow(clippy::cast_possible_truncation, reason = "extrusion per move is small")]
fn e_units(mm: f64) -> i64 {
    (mm * 1e5).round() as i64
}

#[allow(clippy::cast_precision_loss, reason = "retraction units are small")]
fn e_mm(units: i64) -> f64 {
    units as f64 / 1e5
}

/// What every layer of one file reads the same: the template context of the file's settings, and each
/// config's filament views (`PrintConfig::for_filament`, a copy of the whole config when the filament has
/// retraction settings of its own). Each is worked out the first time a layer asks for it.
struct Shared<'c> {
    out: &'c SliceOutput,
    base: &'c PrintConfig,
    /// `customgcode::context` of the base settings.
    ctx: std::sync::OnceLock<template::Context<'c>>,
    /// `customgcode::context` per config index (`LayerPaths::cfg`), for the extrusion role hooks.
    role_ctx: Vec<std::sync::OnceLock<template::Context<'c>>>,
    /// Per config index and 1-based slot.
    filaments: Vec<Vec<std::sync::OnceLock<std::borrow::Cow<'c, PrintConfig>>>>,
    /// The fixed seconds of each layer's tool changes in order (`change_times`).
    change_fixed: Vec<Vec<f64>>,
}

impl<'c> Shared<'c> {
    fn new(out: &'c SliceOutput, base: &'c PrintConfig) -> Self {
        let slots = usize::from(out.tool_count.max(1));
        let configs = out.configs.len() + 1;
        Self {
            out,
            base,
            ctx: std::sync::OnceLock::new(),
            role_ctx: (0..configs).map(|_| std::sync::OnceLock::new()).collect(),
            filaments: (0..configs)
                .map(|_| (0..slots).map(|_| std::sync::OnceLock::new()).collect())
                .collect(),
            change_fixed: if out.tool_count > 1 {
                change_times(out, base)
            } else {
                Vec::new()
            },
        }
    }

    /// A copy of `customgcode::context(base, out)`.
    fn context(&self) -> template::Context<'c> {
        self.ctx
            .once(|| crate::customgcode::context(self.base, self.out))
            .clone()
    }

    /// A copy of `customgcode::context(out.config_at(base, cfg), out)`.
    fn role_context(&self, cfg: u16) -> template::Context<'c> {
        let c = self.out.config_at(self.base, cfg);
        let work = || crate::customgcode::context(c, self.out);
        if let Some(cell) = self.role_ctx.get(usize::from(cfg)) {
            cell.once(work).clone()
        } else {
            work()
        }
    }

    /// `out.config_at(base, cfg).for_filament(slot)`.
    fn filament(&self, cfg: u16, slot: u8) -> std::borrow::Cow<'_, PrintConfig> {
        let c = self.out.config_at(self.base, cfg);
        let cell = self
            .filaments
            .get(usize::from(cfg))
            .and_then(|v| v.get(usize::from(slot.max(1) - 1)));
        if let Some(cell) = cell {
            std::borrow::Cow::Borrowed(&**cell.once(|| c.for_filament(slot)))
        } else {
            c.for_filament(slot)
        }
    }
}

/// Orca slows a layer down and sets its fan from the layer's G-code as written
/// (`CoolingBuffer::parse_layer_gcode`, `calculate_layer_slowdown`, `apply_layer_cooldown`): its travels, the
/// retractions it really makes, wipes, and custom G-code inside the layer (a timelapse shot on a bed slinger)
/// all count, where the paths' model of a layer only estimates them. Each layer short enough for the slowdown
/// or the fan to respond is written once and timed the way the cooling buffer times it; the slowdown is then
/// worked out again from the layer's speeds before it, with the time the written layer spends beyond the
/// model, which the fan reads too. That time does not depend on the paths' speeds. The G-code and the
/// preview both use the settled layers.
pub(crate) fn settle_cooling(out: &mut SliceOutput, config: &PrintConfig) {
    type Settled = (Option<LayerPaths>, f32, Option<LayerChunk>);
    let flavor = config.gcode_flavor;
    let settled: Vec<Option<Settled>> = {
        let shared = Shared::new(out, config);
        let view: &SliceOutput = out;
        par::map(&view.layers, |l| {
            if l.paths.is_empty() {
                return None;
            }
            let c = view.config_at(config, l.cfg);
            let fc = shared.filament(l.cfg, crate::paths::first_slot(l));
            let planned = crate::paths::cooling_time(l, &fc);
            if planned > 2.0 * c.slow_down_layer_time.max(c.fan_cooling_layer_time) + 30.0 {
                return None;
            }
            let chunk = emit_layer(l, view, config, flavor, false, &[], &shared);
            if chunk.error.is_some() {
                return None;
            }
            let beyond = crate::cooling::layer_time(&chunk.bytes) - planned;
            let relaid = crate::paths::recool(l, c, &fc, beyond);
            #[allow(clippy::cast_possible_truncation, reason = "layer times are small")]
            let (planned, beyond) = (planned as f32, beyond as f32);
            // The layer as written stands when neither its speeds nor its fan change.
            let slot = crate::paths::first_slot(l);
            let same = relaid.is_none()
                && layer_fan(c, l.local, planned, slot) == layer_fan(c, l.local, planned + beyond, slot);
            Some((relaid, beyond, same.then_some(chunk)))
        })
    };
    for (l, s) in out.layers.iter_mut().zip(settled) {
        if let Some((relaid, beyond, chunk)) = s {
            if let Some(m) = relaid {
                *l = m;
            }
            l.cooling_extra_s = beyond;
            l.written = chunk.map(std::sync::Arc::new);
        }
    }
}

fn emit_layer(
    l: &LayerPaths,
    out: &SliceOutput,
    base: &PrintConfig,
    flavor: GcodeFlavor,
    resume_first: bool,
    layer_gcode: &[LayerGcode],
    shared: &Shared<'_>,
) -> LayerChunk {
    let tools = usize::from(out.tool_count.max(1));
    let c = out.config_at(base, l.cfg);
    let ultimaker = flavor.is_ultimaker();
    // The nozzle offset the moves are written with (Ultimaker only); cleared for every other printer, as
    // the writer's thread goes on to other layers.
    let first_slot = if l.start_tool == 0 {
        l.paths.first().map_or(0, |p| p.tool.max(1))
    } else {
        l.start_tool
    };
    crate::griffin::set_tool(c, if ultimaker { first_slot } else { 0 });
    // The layer that starts a resumed print follows the start sequence, which already set its values.
    let prev = if resume_first {
        c
    } else {
        out.config_at(base, l.prev_cfg)
    };
    let mut chunk = LayerChunk {
        bytes: Vec::with_capacity(l.points.len() * 28 + 256),
        e_units: vec![0; tools],
        change_time_s: 0.0,
        tool_changes: 0,
        error: None,
    };
    // Custom G-code of this layer, rendered only when the profile or the request has some.
    let wants_templates = [
        "before_layer_change_gcode",
        "layer_change_gcode",
        "change_filament_gcode",
        "extruder_start_gcode",
        "time_lapse_gcode",
        "wrapping_detection_gcode",
        "printing_by_object_gcode",
    ]
    .iter()
    .any(|k| crate::customgcode::text(base, k).is_some())
        || layer_gcode.iter().any(|g| g.layer == l.index);
    let mut ctx = wants_templates.then(|| shared.context());
    if let Some(ctx) = ctx.as_mut() {
        ctx.set_num("layer_num", f64::from(l.index));
        ctx.set_num("layer_z", f64::from(l.z));
        // orca's m_max_layer_z: by object, a later object's layers stay under the earlier tops
        ctx.set_num("max_layer_z", f64::from(l.z.max(l.below_top)));
    }
    let mut error: Option<String> = None;
    // Timelapse and wrapping detection G-code (timelapse.rs).
    let lapse = crate::timelapse::timelapse_spot(base, flavor, l, out.prime_tower.is_some());
    let lapse_body = match lapse {
        Some(_) => custom(base, "time_lapse_gcode", ctx.as_ref(), &mut error),
        None => String::new(),
    };
    // A layer whose G-code reads the filament used so far cannot be rendered on its own: it writes a
    // `;@D` line that finalize renders once the layers before it are known (weight.rs). Rendered here
    // with nothing used yet, the G-code is still checked.
    let templates: Vec<&str> = ["before_layer_change_gcode", "layer_change_gcode"]
        .iter()
        .map(|k| crate::customgcode::text(base, k).unwrap_or(""))
        .collect();
    let deferred = ctx.is_some() && templates.iter().any(|t| crate::weight::wanted(t));
    let before = custom(base, "before_layer_change_gcode", ctx.as_ref(), &mut error);
    let b = &mut chunk.bytes;
    let h = f64::from(l.height);
    let fil_area = std::f64::consts::PI * (c.filament_diameter / 2.0).m_powi(2);
    // The retraction settings of the filament in the nozzle: a filament's own `filament_` values replace the
    // printer's (Orca's `compute_filament_override_value`), so they change with each tool change.
    let mut rc = shared.filament(l.cfg, l.start_tool.max(1));
    let mut retract = e_units(rc.retraction_length);
    let mut retract_feed = feed(rc.retraction_speed);
    // Orca's `GCodeWriter::travel_to_xy` and `_travel_to_z`: the first layer travels at
    // `initial_layer_travel_speed`, and Z moves at `travel_speed_z` unless that is 0, then at the travel speed.
    let first_layer_travel = if l.index == 0 {
        initial_layer_travel_speed(c)
    } else {
        c.travel_speed
    };
    let travel_feed = feed(first_layer_travel);
    let z_feed = match c.raw_number("travel_speed_z", 0.0) {
        v if v > 0.0 => feed(v),
        _ => travel_feed,
    };
    #[allow(clippy::cast_possible_truncation, reason = "z in thousandths fits in i64")]
    let z_top = (f64::from(l.z) * 1000.0).round() as i64;
    // A spiral vase layer starts at the height of the layer below and climbs along its loop.
    let spiral = l.spiral;
    #[allow(
        clippy::cast_possible_truncation,
        reason = "layer height in thousandths is small"
    )]
    let z = if spiral {
        z_top - (h * 1000.0).round() as i64
    } else {
        z_top
    };

    // The fan reads the layer time of the cooling buffer's model, as Orca's `apply_layer_cooldown` does; the
    // cooling buffer writes it ahead of the layer's g-code, before the layer change.
    #[allow(clippy::cast_possible_truncation, reason = "layer times are small")]
    let layer_time = crate::paths::cooling_time(l, &shared.filament(l.cfg, crate::paths::first_slot(l)))
        as f32
        + l.cooling_extra_s;
    let mut layer_fan_value = layer_fan(c, l.local, layer_time, crate::paths::first_slot(l));
    let mut fan_now = layer_fan_value;
    // cura writes the fan after the layer change on an ultimaker
    if !ultimaker {
        b.extend_from_slice(fan_cmd(flavor, fan_now).as_bytes());
    }
    // the auxiliary fan, written when it changes from the layer below (orca's cooling buffer)
    if let Some(v) = aux_fan(c, l.local, l.start_tool.max(1))
        && (l.local == 0 || aux_fan(c, l.local - 1, l.start_tool.max(1)) != Some(v))
    {
        let _ = writeln!(b, "M106 P2 S{v}");
    }
    b.extend_from_slice(b";LAYER_CHANGE\n;Z:");
    put_fixed(b, z_top, 3);
    b.extend_from_slice(b"\n;HEIGHT:");
    #[allow(
        clippy::cast_possible_truncation,
        reason = "layer height in thousandths is small"
    )]
    put_fixed(b, (h * 1000.0).round() as i64, 3);
    b.push(b'\n');
    // As OrcaSlicer orders them: both custom G-codes of a layer change follow the layer
    // markers and come before the lift and the move to the new Z.
    let after = custom(base, "layer_change_gcode", ctx.as_ref(), &mut error);
    let own_stats = !templates.iter().any(|t| t.contains("SET_PRINT_STATS_INFO"))
        && !before.contains("SET_PRINT_STATS_INFO")
        && !after.contains("SET_PRINT_STATS_INFO");
    // `retract_when_changing_layer` (on unless the profile turns it off).
    let layer_retract = !rc.raw.contains_key("retract_when_changing_layer")
        || crate::firmware::truthy(&rc, "retract_when_changing_layer");
    let style = Retraction::of(c, flavor);
    let retracts = style.active(retract) && !l.paths.is_empty() && layer_retract && !spiral;
    // orca's change_layer retract wipes along the layer below's last path when wipe is on
    let tail = &l.below_wipe;
    let mut layer_wiped: Option<Wiped> = None;
    let mut layer_change_retract = |b: &mut Vec<u8>| {
        if !retracts {
            return;
        }
        let speed = if tail.speed_mm_s > 0.0 {
            feed(f64::from(tail.speed_mm_s))
        } else {
            -1
        };
        match l.enter_from {
            Some(at) => {
                layer_wiped = retract_wiping(
                    b,
                    style,
                    (&rc, c),
                    (at, &tail.points, tail.forward),
                    (retract, retract_feed),
                    speed,
                );
            }
            None => retract_move(b, style, -retract, retract_feed),
        }
    };
    if let (true, Some(ctx)) = (deferred, ctx.as_ref()) {
        layer_progress(b, base, flavor, l.index, out.layer_count);
        b.extend_from_slice(
            crate::weight::marker(
                ctx,
                templates.first().copied().unwrap_or(""),
                templates.get(1).copied().unwrap_or(""),
            )
            .as_bytes(),
        );
        // Both custom G-codes render later in one marker, so the retraction follows them.
        layer_change_retract(b);
        if lapse == Some(crate::timelapse::Spot::LayerChange) {
            push_lines(b, &lapse_body);
        }
    } else {
        push_lines(b, &before);
        layer_progress(b, base, flavor, l.index, out.layer_count);
        // Orca's `GCode::change_layer` retracts here, between the two custom G-codes.
        layer_change_retract(b);
        if lapse == Some(crate::timelapse::Spot::LayerChange) {
            push_lines(b, &lapse_body);
        }
        push_lines(b, &after);
    }
    // orca's mark for the layer's fan after the layer change g-code (`GCode::change_layer`)
    if !ultimaker {
        b.extend_from_slice(b";_SET_FAN_SPEED_CHANGING_LAYER\n");
    }
    if flavor == GcodeFlavor::Klipper && own_stats {
        b.extend_from_slice(b"SET_PRINT_STATS_INFO CURRENT_LAYER=");
        put_int(b, i64::from(l.index) + 1);
        b.push(b'\n');
    }
    // Settings a height range changes, written when they differ from the layer below.
    for slot in 1..=out.tool_count.max(1) {
        #[allow(clippy::cast_possible_truncation, reason = "temperatures are small")]
        let (t, t_prev) = (
            PrintConfig::per_slot(&c.nozzle_temperature, slot, 220.0).round() as i64,
            PrintConfig::per_slot(&prev.nozzle_temperature, slot, 220.0).round() as i64,
        );
        #[allow(clippy::cast_precision_loss, reason = "temperatures are small")]
        if t != t_prev {
            temperature_line(
                b,
                flavor,
                t as f64,
                false,
                (out.tool_count > 1).then(|| slot - 1),
                "",
            );
        }
        let pa = c.pressure_advance_for(slot);
        if e_units(pa) != e_units(prev.pressure_advance_for(slot)) {
            pressure_advance(b, flavor, slot, pa);
        }
    }
    // Back to the usual temperatures once the first layer is down.
    if l.index == 1 && !resume_first {
        for slot in 1..=out.tool_count.max(1) {
            // With ooze prevention only the active tool changes; the others stay at standby.
            if ooze_prevention(c) && out.tool_count > 1 && slot != l.start_tool.max(1) {
                continue;
            }
            #[allow(clippy::cast_possible_truncation, reason = "temperatures are small")]
            let (first, usual) = (
                first_layer_temp(c, slot).round() as i64,
                PrintConfig::per_slot(&c.nozzle_temperature, slot, 220.0).round() as i64,
            );
            #[allow(clippy::cast_precision_loss, reason = "temperatures are small")]
            if first != usual {
                temperature_line(
                    b,
                    flavor,
                    usual as f64,
                    false,
                    (out.tool_count > 1).then(|| slot - 1),
                    "",
                );
            }
        }
        let slots = layer_slots(l);
        let initial_key = if c.hot_plate_temp_initial_layer > 0.0 {
            "hot_plate_temp_initial_layer"
        } else {
            "hot_plate_temp"
        };
        let (first_bed, bed) = (
            bed_for(c, initial_key, &slots, first_layer_bed(c)),
            bed_for(c, "hot_plate_temp", &slots, c.hot_plate_temp),
        );
        #[allow(clippy::cast_possible_truncation, reason = "temperatures are small")]
        if first_bed.round() as i64 != bed.round() as i64 {
            b.extend_from_slice(b"M140 S");
            put_int(b, bed.round() as i64);
            b.push(b'\n');
        }
    }
    // Marlin firmware with junction deviation: the first layer sets it (`GCodeWriter::set_junction_deviation`),
    // never above the machine's own limit.
    if l.index == 0
        && flavor == GcodeFlavor::Marlin2
        && let (Some(jd), Some(max)) = (
            crate::motion::raw_f(c, "default_junction_deviation").filter(|v| *v > 0.0),
            crate::motion::raw_f(c, "machine_max_junction_deviation").filter(|v| *v > 0.0),
        )
    {
        b.extend_from_slice(format!("M205 J{:.3}\n", jd.min(max)).as_bytes());
    }
    if ultimaker {
        b.extend_from_slice(fan_cmd(flavor, fan_now).as_bytes());
    }
    let (mut hop, mut lift_ok, mut restart, mut deretract_feed) = lift_and_restart(&rc, f64::from(l.z));
    // Every chunk ends unretracted; an empty layer only moves Z.
    let mut retracted = retracts;
    // How far the nozzle is retracted, for the unretract (a tool change in between can change the length).
    let mut retracted_by = retract;
    // The first layer of a later object (print by object): clear everything printed so far,
    // travel to the start over it, then come down.
    let mut start_at: Option<Point> = None;
    if l.lift_z > 0.0
        && let Some(&first_pt) = l.paths.first().and_then(|p| l.path_points(p).first())
    {
        #[allow(clippy::cast_possible_truncation, reason = "z in thousandths fits in i64")]
        let lift = (f64::from(l.lift_z) * 1000.0).round() as i64;
        b.extend_from_slice(b"G1 Z");
        put_fixed(b, lift, 3);
        b.extend_from_slice(b" F");
        put_int(b, z_feed);
        b.push(b'\n');
        b.extend_from_slice(b"G0");
        put_xy(b, first_pt);
        b.extend_from_slice(b" F");
        put_int(b, travel_feed);
        b.push(b'\n');
        start_at = Some(first_pt);
        // `printing_by_object_gcode`, over the next object before coming down (Orca's `_do_export`), with
        // `current_object_idx` the object's place in the plate list.
        if crate::customgcode::text(base, "printing_by_object_gcode").is_some_and(|t| !t.trim().is_empty()) {
            let (x, y) = (first_pt.x_mm(), first_pt.y_mm());
            let k = out
                .objects
                .iter()
                .position(|o| crate::firmware::inside(&o.hull, x, y, 0.0))
                .unwrap_or(0);
            if let Some(ctx) = ctx.as_mut() {
                #[allow(clippy::cast_precision_loss, reason = "object counts are small")]
                ctx.set_num("current_object_idx", k as f64);
            }
            push_lines(
                b,
                &custom(base, "printing_by_object_gcode", ctx.as_ref(), &mut error),
            );
        }
    }
    // Orca's change_layer lifts with the layer change retraction (a lazy lift, `GCode::retract`): the layer's
    // first travel makes it and the nozzle comes down on the new layer after that travel, or a block at the
    // start of the layer lifts at once before it (`insert_timelapse_gcode` on a Bambu Lab printer). Without a
    // lift the nozzle moves straight to the new height.
    // `retract_lift_enforce` reads the role of the last extrusion other than gap fill, from the layer before on.
    let mut last_fill: Option<Feature> = (lift_enforce(&rc) != LiftEnforce::All)
        .then(|| {
            let at = out.layers.iter().position(|x| std::ptr::eq(x, l))?;
            out.layers
                .get(at.checked_sub(1)?)?
                .paths
                .iter()
                .rev()
                .map(|p| p.feature)
                .find(|f| *f != Feature::GapFill)
        })
        .flatten();
    let mut pending_lift = (retracts
        && lift_ok
        && lift_allowed(&rc, l.index == 0, last_fill)
        && l.lift_z <= 0.0
        && !layer_gcode.iter().any(|g| g.layer == l.index))
    .then(|| Lift::of_layer_change(&rc));
    // A lift made before custom G-code that the next travel keeps and comes down from.
    let mut pending_drop = false;
    if pending_lift.is_none() {
        b.extend_from_slice(b"G1 Z");
        put_fixed(b, z, 3);
        b.extend_from_slice(b" F");
        put_int(b, z_feed);
        b.push(b'\n');
    }
    for g in layer_gcode.iter().filter(|g| g.layer == l.index) {
        let text = match (g.kind.as_str(), g.gcode.as_deref()) {
            ("custom", Some(t)) => ctx
                .as_ref()
                .map(|c| crate::customgcode::render_text(t, c, "custom G-code"))
                .transpose()
                .unwrap_or_else(|e| {
                    error.get_or_insert(e);
                    None
                })
                .unwrap_or_default(),
            ("pause", _) => match crate::customgcode::text(base, "machine_pause_gcode") {
                Some(_) => custom(base, "machine_pause_gcode", ctx.as_ref(), &mut error),
                None => "M601".to_owned(),
            },
            ("color_change", _) => match crate::customgcode::text(base, "color_change_gcode") {
                Some(_) => custom(base, "color_change_gcode", ctx.as_ref(), &mut error),
                None => "M600".to_owned(),
            },
            _ => String::new(),
        };
        push_lines(b, &text);
    }

    let mut tool: u8 = if l.start_tool == 0 { u8::MAX } else { l.start_tool };
    // The filament the start G-code leaves loaded (its last `T` under 255, Orca's
    // `GCodeProcessor::get_gcode_last_filament`): the first layer starts on it without a tool
    // command of its own, as Orca's `set_extruder` after the start G-code writes none.
    let start_loaded: Option<u8> = if ultimaker && l.index == 0 && l.start_tool == 0 {
        // Ultimaker's start selects the first core itself.
        Some(first_slot.max(1) - 1)
    } else {
        (l.index == 0 && l.start_tool == 0 && out.tool_count > 1)
            .then(|| {
                let mut c = shared.context();
                c.set_num("layer_num", 0.0);
                c.set_num("layer_z", f64::from(l.z));
                crate::customgcode::render(base, &c, "machine_start_gcode")
                    .ok()
                    .flatten()
            })
            .flatten()
            .and_then(|s| last_filament(&s))
    };
    // Ultimaker: the print cores that have printed before (the start primes the first one), as the plan
    // knows them, so an output that starts mid print knows them too.
    let tool_bit = |t: u8| 1u64 << u32::from(t.max(1) - 1).min(63);
    let mut primed_mask = l.tools_before | if l.index == 0 { tool_bit(first_slot) } else { 0 };
    // With a filament map: what each nozzle holds, so a change flushes only what its nozzle holds.
    let mut held: Vec<u8> = l.held_before.clone();
    let mut change_time = 0.0f64;
    let mut change_i = 0usize;
    let mut first_path = true;
    // A spiral layer goes on from where the layer below ended: no travel to the loop's start.
    // Otherwise it starts where the layer below ended, when that is known.
    let mut cursor: Option<Point> = if spiral && !l.spiral_start {
        l.paths.first().and_then(|p| l.path_points(p).first().copied())
    } else {
        start_at.or(layer_wiped.as_ref().map(|w| w.end)).or(l.enter_from)
    };
    let mut feature: Option<Feature> = None;
    // Extrusion role change G-code (`change_extrusion_role_gcode` and the filament's and process's).
    let mut role_ctx = crate::customgcode::role_hooks(c).then(|| shared.role_context(l.cfg));
    // the width last written, in thousandths as written: the layer below's last, which orca's writer still holds
    #[allow(clippy::cast_possible_truncation, reason = "width in thousandths is small")]
    let thousandths = |w: f32| (f64::from(w) * 1000.0).round() as i64;
    let mut width_written = thousandths(l.below_wipe.width_mm);
    // The role-based extrusion multipliers of this layer.
    let role_flow: Vec<f64> = (0..=Feature::InternalBridge as usize)
        .map(|i| {
            let f = match i {
                0 => Feature::OuterWall,
                1 => Feature::InnerWall,
                2 => Feature::OverhangWall,
                3 => Feature::TopSurface,
                4 => Feature::BottomSurface,
                5 => Feature::InternalSolid,
                6 => Feature::SparseInfill,
                7 => Feature::Bridge,
                8 => Feature::Support,
                9 => Feature::SupportInterface,
                10 => Feature::Brim,
                11 => Feature::Ironing,
                12 => Feature::GapFill,
                13 => Feature::PrimeTower,
                14 => Feature::Custom,
                15 => Feature::Skirt,
                _ => Feature::InternalBridge,
            };
            c.role_flow_ratio(f, l.index == 0)
        })
        .collect();
    // `small_area_infill_flow_compensation`: short solid infill lines extrude less (smallflow.rs).
    let small_area = crate::smallflow::Compensator::of(c);
    let mut speed_feed = layer_wiped.as_ref().map_or(-1, |w| w.feed);
    // Where the bytes written since the last path's feed rate decision start: travels, retractions,
    // wipes, lifts and custom G-code there may have set another feed rate.
    let mut feed_mark = 0usize;
    let mut last_pts: &[Point] = &[];
    // Orca wipes forward along a loop (past its start) and backward along any other path.
    let wipe_forward = true;
    let mut last_was_loop = false;
    let labels = crate::firmware::Labels::new(&out.objects, base, flavor);
    // The layer's timelapse block (on a Bambu Lab printer inside the mask of the layer's objects), then
    // its wrapping detection block, each with the spot it goes in.
    let mut blocks: Vec<(crate::timelapse::Spot, String)> = Vec::new();
    if let Some(spot) = lapse.filter(|s| *s != crate::timelapse::Spot::LayerChange) {
        let wrap = labels.as_ref().and_then(|lb| {
            let objects: std::collections::BTreeSet<usize> = l
                .paths
                .iter()
                .filter_map(|p| l.path_points(p).first().and_then(|&s| lb.object_of(s, p.feature)))
                .collect();
            lb.layer_wrap(l.index, &objects)
        });
        let mut text = String::new();
        if let Some((open, _)) = &wrap {
            text.push_str(open);
        }
        push_text(&mut text, &lapse_body);
        if let Some((_, close)) = &wrap {
            text.push_str(close);
        }
        blocks.push((spot, text));
    }
    if let Some(spot) = crate::timelapse::wrapping_spot(base, l) {
        blocks.push((
            spot,
            custom(base, "wrapping_detection_gcode", ctx.as_ref(), &mut error),
        ));
    }
    blocks.retain(|(_, t)| !t.is_empty());
    for (_, text) in blocks.iter().filter(|(s, _)| *s == crate::timelapse::Spot::Start) {
        if pending_lift.take().is_some() {
            write_eager_lift(b, &rc, Lift::of_block(&rc), cursor, z, hop, z_feed);
            pending_drop = true;
        }
        push_lines(b, text);
        if crate::timelapse::moves_z(text) && !pending_drop {
            b.extend_from_slice(b"G1 Z");
            put_fixed(b, z, 3);
            b.extend_from_slice(b" F");
            put_int(b, z_feed);
            b.push(b'\n');
        }
        if crate::timelapse::moves_head(text) {
            cursor = None;
        }
    }
    // The object whose label is open. Object labels open after the retract that
    // leaves the last object and close before the retract that leaves this one, so
    // the travel to the next object belongs to it and a skipped object skips it.
    let mut open_object: Option<usize> = None;
    let wipe_loops = crate::firmware::truthy(c, "wipe_on_loops");
    let wipe_before_loop = crate::firmware::truthy(c, "wipe_before_external_loop")
        && c.wall_sequence == crate::config::WallSequence::OuterInner;
    let comb = crate::firmware::truthy(c, "reduce_crossing_wall");
    let reduce_infill = crate::firmware::truthy(c, "reduce_infill_retraction");
    let detour = detour_limit(c);
    let travel_layout = (comb || reduce_infill)
        .then(|| crate::travel::Layout::for_travels(l, c, comb))
        .flatten();
    let accel_on = crate::motion::accel_enabled(c);
    // Extrusion rate smoothing turns arc fitting off (as Orca's tooltip says): it works on straight moves.
    let smoothing = crate::equalizer::Params::of(c, out.tool_count);
    let arcs = crate::firmware::truthy(c, "enable_arc_fitting") && !spiral && smoothing.is_none();
    // Acceleration and jerk last written in this layer (0: not yet), and the lines that set them.
    let mut motion_now = crate::motion::Written::default();
    let mut motion = crate::motion::Motion::new(c, flavor, l.index == 0);
    // The nozzle's height in thousandths while it extrudes (a scarf rise starts below the layer).
    let mut cur_z: i64 = z;
    // orca's bambu tower writer frames each tower block: `WIPE_TOWER_START` to `END`, and a change in
    // `CP TOOLCHANGE START` to `END` (`WipeTower::tool_change_new`); true while a change block is open
    let bbl_tower = crate::firmware::bambu_printer(c, flavor) && out.prime_tower.is_some();
    let mut tower_block: Option<bool> = None;
    for (pi, p) in l.paths.iter().enumerate() {
        let pts = l.path_points(p);
        let Some(&start) = pts.first() else { continue };
        let swaps_here = p.tool != tool && tool != u8::MAX;
        if let Some(changed) = tower_block
            && (p.feature != Feature::PrimeTower || swaps_here)
        {
            close_tower_block(b, changed, c);
            tower_block = None;
        }
        if bbl_tower && tower_block.is_none() && p.feature == Feature::PrimeTower && !swaps_here {
            b.extend_from_slice(b"; WIPE_TOWER_START\n");
            tower_block = Some(false);
        }
        // A block that waits for a moment inside the layer: retracted, out of the object's label.
        // orca's retract with apply_instantly: a wipe when on, the object's label left open (process_layer)
        for (_, text) in blocks
            .iter()
            .filter(|(s, _)| *s == crate::timelapse::Spot::Before(pi))
        {
            if !retracted && style.active(retract) {
                let at = cursor.unwrap_or(start);
                if let Some(w) = retract_wiping(
                    b,
                    style,
                    (&rc, c),
                    (at, last_pts, wipe_forward && last_was_loop),
                    (retract, retract_feed),
                    speed_feed,
                ) {
                    speed_feed = w.feed;
                    cursor = Some(w.end);
                }
                retracted = true;
                retracted_by = retract;
            }
            // Orca retracts and lifts at once before the block (`GCode::retract` with `apply_instantly`); the
            // travel after it keeps the height and comes down at the path.
            if lift_ok && retracted && !pending_drop {
                pending_lift = None;
                write_eager_lift(b, &rc, Lift::of_block(&rc), cursor, z, hop, z_feed);
                pending_drop = true;
            }
            push_lines(b, text);
            if crate::timelapse::moves_z(text) && !pending_drop {
                b.extend_from_slice(b"G1 Z");
                put_fixed(b, z, 3);
                b.extend_from_slice(b" F");
                put_int(b, z_feed);
                b.push(b'\n');
            }
            if crate::timelapse::moves_head(text) {
                cursor = None;
            }
        }
        let want_object = labels.as_ref().and_then(|lb| lb.object_of(start, p.feature));
        if let Some(lb) = labels.as_ref()
            && want_object != open_object
        {
            if let Some(t) = open_object.and_then(|prev| lb.comment_end(prev)) {
                b.extend_from_slice(t.as_bytes());
            }
            if let Some(t) = want_object.and_then(|o| lb.comment_start(o)) {
                b.extend_from_slice(t.as_bytes());
            }
        }
        if first_path && tool == u8::MAX && !resume_first && start_loaded == Some(p.tool.max(1) - 1) {
            tool = p.tool;
        }
        // Orca's tower writer moves between the pieces of one filament's tower block (outline,
        // purge rows, the fill above them) without retracting.
        let within_tower =
            feature == Some(Feature::PrimeTower) && p.feature == Feature::PrimeTower && p.tool == tool;
        if (p.tool != tool && (tool != u8::MAX || out.tool_count > 1))
            || (first_path && out.tool_count > 1 && (tool == u8::MAX || resume_first))
        {
            if p.tool != tool && tool != u8::MAX {
                chunk.tool_changes += 1;
            }
            let next = i64::from(p.tool.max(1) - 1);
            let from = (tool != u8::MAX).then(|| i64::from(tool.max(1) - 1));
            let oozing = !ultimaker && ooze_prevention(c) && p.tool != tool && tool != u8::MAX && tool != 0;
            // orca's set_extruder: retract for the tool change, then a spiral lift made at once before the
            // change g-code, whatever the lift type
            let swap = !ultimaker && p.tool != tool && tool != u8::MAX;
            let tower_change = bbl_tower && swap && p.feature == Feature::PrimeTower;
            if tower_change {
                let kind = |slot: u8| crate::customgcode::filament_type(c, slot);
                let _ = write!(
                    b,
                    ";--------------------\n; CP TOOLCHANGE START\n; toolchange #{}\n; material : {} -> {}\n;--------------------\nM220 S100\n; WIPE_TOWER_START\n",
                    u64::from(l.changes_before) + u64::try_from(change_i).unwrap_or(0) + 1,
                    kind(tool.max(1)),
                    kind(p.tool.max(1)),
                );
            }
            let tc = e_units(crate::tower::per_slot_raw(
                &rc,
                "retract_length_toolchange",
                tool.max(1),
                10.0,
            ));
            if swap && retracted && !style.firmware && tc > retracted_by {
                // already retracted for the travel: down to the tool change length
                retract_move(b, style, retracted_by - tc, retract_feed);
                retracted_by = tc;
            } else if swap && !retracted && style.active(tc) {
                let at = cursor.unwrap_or(start);
                if let Some(w) = retract_wiping(
                    b,
                    style,
                    (&rc, c),
                    (at, last_pts, wipe_forward && last_was_loop),
                    (tc, retract_feed),
                    speed_feed,
                ) {
                    speed_feed = w.feed;
                }
                retracted = true;
                retracted_by = tc;
            }
            let change_from = b.len();
            if oozing && let Some(t) = standby_temp(c, tool, l.index) {
                tool_temp(b, flavor, tool, t, false, "cooldown");
            }
            if swap
                && lift_ok
                && !pending_drop
                && style.active(retract)
                && lift_allowed(&rc, l.index == 0, last_fill)
            {
                pending_lift = None;
                write_eager_lift(b, &rc, Lift::Spiral, cursor, z, hop, z_feed);
                pending_drop = true;
            }
            match (from, ctx.as_mut()) {
                // Ultimaker: Cura's print core switch; the firmware works the lift switch (griffin.rs).
                (Some(_), _) if ultimaker && p.tool != tool => {
                    let to_rc = shared.filament(l.cfg, p.tool.max(1));
                    let bit = tool_bit(p.tool);
                    let primed = primed_mask & bit != 0;
                    primed_mask |= bit;
                    // Cura's lift after a switch (`retraction_hop_after_extruder_switch_height`), else the usual lift.
                    let lift = crate::tower::per_slot_raw(&rc, "z_hop", tool.max(1), 0.0);
                    let hop = crate::tower::per_slot_raw(&rc, "retract_lift_toolchange", tool.max(1), lift);
                    let tool_text = match ctx.as_mut() {
                        Some(ctx) => {
                            for (k, v) in [
                                ("previous_extruder", tool.max(1) - 1),
                                ("current_extruder", p.tool.max(1) - 1),
                                ("next_extruder", p.tool.max(1) - 1),
                            ] {
                                ctx.set_num(k, f64::from(v));
                            }
                            custom(base, "extruder_start_gcode", Some(&*ctx), &mut error)
                        }
                        None => String::new(),
                    };
                    #[allow(
                        clippy::cast_possible_truncation,
                        clippy::cast_precision_loss,
                        reason = "a hop and a retraction are small"
                    )]
                    let w = crate::griffin::Switch {
                        tool_start: &tool_text,
                        from: &rc,
                        to: &to_rc,
                        from_slot: tool.max(1),
                        to_slot: p.tool.max(1),
                        z,
                        hop: (hop * 1000.0).round() as i64,
                        retracted_mm: if retracted { retracted_by as f64 / 1e5 } else { 0.0 },
                        primed,
                        travel_feed,
                        z_feed,
                        from_print: print_temp(c, tool, l.index),
                        to_print: print_temp(c, p.tool, l.index),
                    };
                    let (text, left) = crate::griffin::switch(&w);
                    b.extend_from_slice(text.as_bytes());
                    crate::griffin::set_tool(c, p.tool.max(1));
                    // Left lifted and retracted at the switching position: the next travel comes down and primes.
                    retracted = left > 0.0;
                    retracted_by = e_units(left);
                    pending_drop = true;
                    cursor = None;
                }
                // The profile's tool change G-code stands in for the bare T command.
                (Some(prev), Some(ctx))
                    if p.tool != tool
                        && crate::customgcode::text(base, "change_filament_gcode").is_some() =>
                {
                    for (k, v) in [
                        ("previous_extruder", prev),
                        ("current_extruder", prev),
                        ("next_extruder", next),
                        ("current_filament_id", prev),
                        ("next_filament_id", next),
                    ] {
                        #[allow(clippy::cast_precision_loss, reason = "tool indexes are small")]
                        ctx.set_num(k, v as f64);
                    }
                    ctx.set_num("toolchange_z", f64::from(l.z));
                    // orca's change at the tower reads the new filament's outer wall volumetric speed, any other
                    // change the start's (`WipeTowerIntegration::append_tcr`)
                    let speed_slot = if p.feature == Feature::PrimeTower {
                        p.tool.max(1)
                    } else {
                        crate::customgcode::first_filaments(base, out).1 + 1
                    };
                    ctx.set_num(
                        "outer_wall_volumetric_speed",
                        crate::customgcode::outer_wall_volumetric_speed(base, speed_slot),
                    );
                    // The flush starts from what the new filament's nozzle holds: the old filament on one
                    // nozzle, nothing when the nozzle already holds the new one or is empty.
                    let flush_from = match out.filament_map.as_ref() {
                        Some(m) => held
                            .get(m.nozzle_of(p.tool))
                            .copied()
                            .filter(|&h| h != 0)
                            .map(|h| i64::from(h - 1)),
                        None => Some(prev),
                    };
                    crate::tower::tool_change_vars(
                        ctx,
                        c,
                        out.tool_count,
                        prev,
                        next,
                        flush_from,
                        p.feature == Feature::PrimeTower,
                    );
                    // orca counts the changes of the print, this one included (`m_toolchange_count`)
                    ctx.set_num(
                        "toolchange_count",
                        f64::from(l.changes_before) + f64::from(u32::try_from(change_i).unwrap_or(0)) + 1.0,
                    );
                    // orca's tower change ends the old filament first (`append_tcr`, `filament_end_gcode`)
                    if tower_change {
                        // after the retraction and the lift, the object's label closes (`add_object_end_labels`)
                        if let (Some(lb), Some(prev)) = (labels.as_ref(), open_object.take())
                            && let Some(t) = lb.fw_end(prev)
                        {
                            b.extend_from_slice(t.as_bytes());
                        }
                        let mut fctx = ctx.clone();
                        fctx.set_num("filament_extruder_id", f64::from(tool.max(1) - 1));
                        fctx.extruder = usize::from(tool.max(1) - 1);
                        match crate::customgcode::render_slot(base, &fctx, "filament_end_gcode", tool.max(1))
                        {
                            Ok(t) => push_lines(b, &t.unwrap_or_default()),
                            Err(e) => {
                                error.get_or_insert(e);
                            }
                        }
                        b.push(b'\n');
                    }
                    let text = custom(base, "change_filament_gcode", Some(&*ctx), &mut error);
                    // orca's cooling buffer drops the feed rates that change nothing in the layer's g-code
                    let text = strip_feeds(&text, last_feed(b).unwrap_or(0));
                    push_lines(b, &text);
                    // orca's cooling buffer sets the fans again after the change (`_FORCE_RESUME_FAN_SPEED`):
                    // the auxiliary fan, then the part fan of the new filament
                    if let Some(v) = aux_fan(c, l.local, p.tool.max(1)) {
                        let _ = writeln!(b, "M106 P2 S{v}");
                    }
                    layer_fan_value = layer_fan(c, l.local, layer_time, p.tool.max(1));
                    fan_now = layer_fan_value;
                    b.extend_from_slice(fan_cmd(flavor, fan_now).as_bytes());
                    // Orca writes the tool command itself when the profile's G-code does not select the new
                    // tool (`custom_gcode_changes_tool`); a bambu lab printer's is `M1020 S`.
                    let prefix = if crate::firmware::bambu_printer(c, flavor) {
                        "M1020 S"
                    } else {
                        toolchange_prefix(flavor)
                    };
                    if !changes_tool(&text, prefix, next) {
                        b.extend_from_slice(prefix.as_bytes());
                        put_int(b, next);
                        b.push(b'\n');
                    }
                    // then the new filament's start, and the tower wipe
                    if tower_change {
                        let mut fctx = ctx.clone();
                        fctx.set_num("filament_extruder_id", f64::from(p.tool.max(1) - 1));
                        fctx.extruder = usize::from(p.tool.max(1) - 1);
                        match crate::customgcode::render_slot(
                            base,
                            &fctx,
                            "filament_start_gcode",
                            p.tool.max(1),
                        ) {
                            Ok(t) => push_lines(b, &t.unwrap_or_default()),
                            Err(e) => {
                                error.get_or_insert(e);
                            }
                        }
                        b.extend_from_slice(b"G4 S0\n; CP TOOLCHANGE WIPE\n");
                        tower_block = Some(true);
                    }
                }
                _ => {
                    b.extend_from_slice(toolchange_prefix(flavor).as_bytes());
                    put_int(b, next);
                    b.push(b'\n');
                }
            }
            if oozing && c.raw_number("standby_temperature_delta", -5.0) != 0.0 {
                tool_temp(
                    b,
                    flavor,
                    p.tool,
                    print_temp(c, p.tool, l.index),
                    true,
                    "back from standby",
                );
            }
            if p.tool != tool && tool != u8::MAX {
                let start = cursor.map(|q| [q.x_mm(), q.y_mm()]);
                let fixed = shared
                    .change_fixed
                    .get(l.index as usize)
                    .and_then(|v| v.get(change_i))
                    .copied();
                change_i += 1;
                change_time += tool_change_time(
                    c,
                    fixed,
                    b.get(change_from..).unwrap_or(&[]),
                    start,
                    f64::from(l.z),
                );
            }
            tool = p.tool;
            if let Some(m) = out.filament_map.as_ref() {
                let n = m.nozzle_of(tool);
                if held.len() <= n {
                    held.resize(n + 1, 0);
                }
                if let Some(h) = held.get_mut(n) {
                    *h = tool;
                }
            }
            rc = shared.filament(l.cfg, tool.max(1));
            (retract, retract_feed) = (e_units(rc.retraction_length), feed(rc.retraction_speed));
            (hop, lift_ok, restart, deretract_feed) = lift_and_restart(&rc, f64::from(l.z));
        }
        first_path = false;
        // Travel.
        let dist = cursor.map_or(f64::INFINITY, |cur| cur.dist_mm(start));
        // Combing and the internal-region test, when the profile asks for either.
        let plan = match (cursor, travel_layout.as_ref()) {
            (Some(cur), Some(lay)) => {
                let limit = match detour {
                    Detour::Mm(v) => v,
                    Detour::Percent(p) => dist * p / 100.0,
                };
                Some(lay.plan(cur, start, comb, limit))
            }
            _ => None,
        };
        // Orca's rule (GCode::needs_retraction): leaving an outer or overhang wall always retracts; a travel to
        // anything but a wall needs none when it stays inside an internal region of the layer and sparse infill is on.
        let left_outer = matches!(feature, Some(Feature::OuterWall | Feature::OverhangWall));
        let in_infill = reduce_infill
            && c.sparse_infill_density > 0.0
            && !left_outer
            && !crate::travel::is_wall(p.feature)
            && plan.as_ref().is_some_and(|p| p.internal);
        let route_len = plan.as_ref().map_or(dist, |p| {
            let mut from = cursor.unwrap_or(start);
            p.route
                .iter()
                .map(|&q| {
                    let d = from.dist_mm(q);
                    from = q;
                    d
                })
                .sum()
        });
        // Orca's same rule for support: a travel to a support path that stays inside one support island (or,
        // for slim, strong and hybrid trees, inside the branch areas) needs no retraction.
        let in_support = p.feature == Feature::Support
            && !left_outer
            && l.support_areas.as_ref().is_some_and(|a| {
                let mut from = cursor.unwrap_or(start);
                let legs: Vec<Point> = plan.as_ref().map_or_else(
                    || vec![start],
                    |p| {
                        let mut v = p.route.clone();
                        if v.last() != Some(&start) {
                            v.push(start);
                        }
                        v
                    },
                );
                legs.into_iter().all(|q| {
                    let ok = a.holds(from, q);
                    from = q;
                    ok
                })
            });
        let need_retract = style.active(retract)
            && !retracted
            && route_len > rc.retraction_minimum_travel
            && !in_infill
            && !in_support
            && !within_tower;
        // Orca's GCode::_extrude calls travel_to, which writes the travel's acceleration and jerk, only when the
        // nozzle is not already at the path's first point or a layer change still owes its lift: paths that
        // join end to start (a zig-zag fill) get no travel lines between them.
        if accel_on && (cursor != Some(start) || pending_lift.is_some()) {
            // A travel shorter than the retraction minimum is short whether or not it retracts.
            let short = dist < rc.retraction_minimum_travel;
            let lines = motion.travel_lines(short, p.feature, &mut motion_now);
            b.extend_from_slice(lines.as_bytes());
        }
        let mut lifted = std::mem::take(&mut pending_drop);
        // A slope lift too steep for its travel climbs on the travel move itself (Orca's `travel_to_xyz`).
        let mut lift_on_travel: Option<i64> = None;
        // The layer change's lift, made by the layer's first travel; with no travel to make it on, the nozzle
        // just moves to the layer's height.
        if let Some(kind) = pending_lift.take() {
            match cursor.filter(|&from| from != start) {
                Some(from) => {
                    lift_on_travel = write_lift(b, &rc, kind, from, start, z, hop, travel_feed, z_feed);
                    lifted = true;
                }
                None => write_normal_lift(b, z, z_feed),
            }
        }
        if need_retract {
            let at = cursor.unwrap_or(start);
            if let Some(w) = retract_wiping(
                b,
                style,
                (&rc, c),
                (at, last_pts, wipe_forward && last_was_loop),
                (retract, retract_feed),
                speed_feed,
            ) {
                speed_feed = w.feed;
            }
            retracted = true;
            retracted_by = retract;
            if lift_ok && !lifted && lift_allowed(&rc, l.index == 0, last_fill) {
                // A travel that retracts lifts as Orca's needs_retraction picks: Auto Lift slopes, the others are
                // their own kind.
                if let Some(from) = cursor {
                    let first = plan
                        .as_ref()
                        .and_then(|p| p.route.first().copied())
                        .unwrap_or(start);
                    let over = || {
                        l.lift_overhangs
                            .as_ref()
                            .is_some_and(|h| over_overhang(c, &rc, h, from, first))
                    };
                    lift_on_travel = write_lift(
                        b,
                        &rc,
                        Lift::of_travel(&rc, over),
                        from,
                        start,
                        z,
                        hop,
                        travel_feed,
                        z_feed,
                    );
                } else {
                    write_normal_lift(b, z + hop, z_feed);
                }
                lifted = true;
            }
        }
        if let Some(lb) = labels.as_ref()
            && want_object != open_object
        {
            if let Some(prev) = open_object
                && let Some(t) = lb.fw_end(prev)
            {
                b.extend_from_slice(t.as_bytes());
            }
            if let Some(t) = want_object.and_then(|o| lb.fw_start(o)) {
                b.extend_from_slice(t.as_bytes());
            }
            open_object = want_object;
        }
        // Wipe before external loop: with the outer wall first, the nozzle lands a little before
        // the start of the loop, unretracts there and then moves onto the start.
        let approach = (wipe_before_loop
            && p.feature == Feature::OuterWall
            && retracted
            && pts.len() > 3
            && is_loop(pts))
        .then(|| pts.get(1).and_then(|&q| before_start(start, q)))
        .flatten();
        if cursor != Some(start) {
            let mut route = plan.as_ref().map_or_else(|| vec![start], |p| p.route.clone());
            if let (Some(a), Some(last)) = (approach, route.last_mut()) {
                *last = a;
            }
            for stop in route {
                b.extend_from_slice(b"G0");
                put_xy(b, stop);
                if let Some(zl) = lift_on_travel.take() {
                    b.extend_from_slice(b" Z");
                    put_fixed(b, zl, 3);
                }
                b.extend_from_slice(b" F");
                put_int(b, travel_feed);
                b.push(b'\n');
            }
        }
        if lifted {
            b.extend_from_slice(b"G1 Z");
            put_fixed(b, z, 3);
            b.extend_from_slice(b" F");
            put_int(b, z_feed);
            b.push(b'\n');
        }
        if retracted {
            retract_move(b, style, retracted_by + restart, deretract_feed);
            retracted = false;
        }
        if approach.is_some() && cursor != Some(start) {
            b.extend_from_slice(b"G1");
            put_xy(b, start);
            b.push(b'\n');
        }
        if accel_on {
            // After a travel the jerk is the default again; the feature's own comes back with the extrusion.
            let lines = motion.accel_lines(p.feature, &mut motion_now);
            b.extend_from_slice(lines.as_bytes());
        }
        if feature != Some(p.feature) {
            if let Some(rc) = role_ctx.as_mut() {
                match crate::customgcode::role_change(
                    c,
                    rc,
                    p.tool,
                    p.feature,
                    feature,
                    l.index + 1,
                    f64::from(l.z),
                ) {
                    Ok(t) => b.extend_from_slice(t.as_bytes()),
                    Err(e) => {
                        error.get_or_insert(e);
                    }
                }
            }
            b.extend_from_slice(b";TYPE:");
            b.extend_from_slice(p.feature.gcode_label().as_bytes());
            b.push(b'\n');
            // orca's _extrude writes the width only when it changes, and always after the tower
            if thousandths(p.width_mm) != width_written || feature == Some(Feature::PrimeTower) {
                width_written = thousandths(p.width_mm);
                b.extend_from_slice(b";WIDTH:");
                put_fixed(b, width_written, 3);
                b.push(b'\n');
            }
            feature = Some(p.feature);
        }
        if p.feature != Feature::GapFill {
            last_fill = Some(p.feature);
        }
        // Fans by role, as Orca's cooling buffer sets them (`CoolingBuffer::apply_layer_cooldown`): none before
        // `close_fan_the_first_x_layers`; then overhangs and bridges, internal bridges, support interface and
        // ironing, in that order of precedence, each over the layer's own fan.
        if l.local >= c.close_fan_the_first_x_layers {
            let value = |pct: f64| fan_pwm(c, pct);
            let overhang = value(
                fan_ramp(c, l.local)
                    .map_or(c.overhang_fan_speed, |f| (c.overhang_fan_speed * f + 0.5).floor()),
            );
            // Overhang cooling takes over only when it is faster than the layer's fan.
            let overhang_on = c.enable_overhang_bridge_fan && overhang > layer_fan_value;
            // `overhang_fan_threshold` 0% cools every outer wall like an overhang (Orca's `Overhang_threshold_none`);
            // above it, the pieces of a wall that hang past the threshold do (`PathInfo::overhang_fan`).
            let outer_too = p.feature == Feature::OuterWall && overhang_fan_on_walls(c);
            let own = |key: &str| {
                Some(crate::tower::per_slot_raw(c, key, p.tool, -1.0))
                    .filter(|v| *v >= 0.0)
                    .map(value)
            };
            let want = if (matches!(p.feature, Feature::Bridge | Feature::OverhangWall)
                || outer_too
                || p.overhang_fan)
                && overhang_on
            {
                overhang
            } else if p.feature == Feature::InternalBridge && c.enable_overhang_bridge_fan {
                // `internal_bridge_fan_speed` -1 follows the overhang fan.
                match own("internal_bridge_fan_speed") {
                    Some(v) => v,
                    None if overhang_on => overhang,
                    None => layer_fan_value,
                }
            } else if p.feature == Feature::SupportInterface {
                own("support_material_interface_fan_speed").unwrap_or(layer_fan_value)
            } else if p.feature == Feature::Ironing {
                own("ironing_fan_speed").unwrap_or(layer_fan_value)
            } else {
                layer_fan_value
            };
            if want != fan_now {
                b.extend_from_slice(fan_cmd(flavor, want).as_bytes());
                fan_now = want;
            }
        }
        // Variable-width walls change width inside a feature.
        if thousandths(p.width_mm) != width_written {
            width_written = thousandths(p.width_mm);
            b.extend_from_slice(b";WIDTH:");
            put_fixed(b, width_written, 3);
            b.push(b'\n');
        }
        // Brick layers: a bead printed half a layer higher than the layer it belongs to.
        let lifted_bead = p.dz != 0.0 && !spiral;
        if lifted_bead {
            #[allow(clippy::cast_possible_truncation, reason = "z in thousandths fits in i64")]
            let zb = z + (f64::from(p.dz) * 1000.0).round() as i64;
            b.extend_from_slice(b"G1 Z");
            put_fixed(b, zb, 3);
            b.extend_from_slice(b" F");
            put_int(b, z_feed);
            b.push(b'\n');
            speed_feed = -1;
        }
        // The feed rate the printer holds is the last F written on any move (G0 and G1 share it), as
        // Orca's cooling buffer tracks it when it drops a path's `G1 F` that changes nothing.
        if let Some(v) = last_feed(b.get(feed_mark..).unwrap_or(&[])) {
            speed_feed = v;
        }
        let f = feed(f64::from(p.speed_mm_s));
        if f != speed_feed {
            b.extend_from_slice(b"G1 F");
            put_int(b, f);
            b.push(b'\n');
            speed_feed = f;
        }
        feed_mark = b.len();
        let e_per_mm = bead_area(f64::from(p.width_mm), h) / fil_area
            * c.flow_ratio(p.tool)
            * f64::from(p.flow)
            * role_flow.get(p.feature as usize).copied().unwrap_or(1.0);
        let mut prev = start;
        let mut e_sum = 0i64;
        let small = small_area.as_ref().filter(|s| s.applies(p.feature, l.index == 0));
        let line_e = |len: f64| e_units(len * e_per_mm * small.map_or(1.0, |s| s.factor(len)));
        // Points with their own Z and flow: a spiral vase layer, or the sloped parts of a scarf seam.
        let spans = (!l.zs.is_empty())
            .then(|| {
                let (s, e) = (p.start as usize, p.end as usize);
                l.zs.get(s..e).zip(l.flows.get(s..e))
            })
            .flatten()
            .filter(|(zv, fv)| {
                spiral
                    || zv.iter().any(|z| (z - l.z).abs() > 1e-4)
                    || fv.iter().any(|f| (f - 1.0).abs() > 1e-4)
            });
        #[allow(clippy::cast_possible_truncation, reason = "z in thousandths fits in i64")]
        let z_i = |v: f32| (f64::from(v) * 1000.0).round() as i64;
        if let Some((zv, fv)) = spans {
            // A scarf rise starts below the layer: the nozzle goes down to it before extruding.
            if !spiral
                && let Some(&z0) = zv.first()
                && z_i(z0) != cur_z
            {
                b.extend_from_slice(b"G1 Z");
                put_fixed(b, z_i(z0), 3);
                b.extend_from_slice(b" F");
                put_int(b, z_feed);
                b.push(b'\n');
                cur_z = z_i(z0);
                speed_feed = -1;
            }
            // `G1 X Y Z E`: the flow of the first layer ramps up and the repeated last loop ramps down, so
            // a segment may carry no extrusion at all.
            for ((&q, &zq), &fq) in pts.iter().zip(zv).zip(fv).skip(1) {
                let len = prev.dist_mm(q);
                if len <= 0.0 {
                    continue;
                }
                let e = e_units(len * e_per_mm * f64::from(fq));
                b.extend_from_slice(b"G1");
                put_xy(b, q);
                if spiral || z_i(zq) != cur_z {
                    b.extend_from_slice(b" Z");
                    put_fixed(b, z_i(zq), 3);
                    cur_z = z_i(zq);
                }
                b.extend_from_slice(b" E");
                put_fixed(b, e.max(0), 5);
                b.push(b'\n');
                e_sum += e;
                prev = q;
            }
        } else if arcs {
            for seg in crate::arcfit::fit(pts, arc_tolerance(c, p.feature)) {
                match seg {
                    crate::arcfit::Seg::Line(q) => {
                        let e = line_e(prev.dist_mm(q));
                        if e <= 0 {
                            continue;
                        }
                        b.extend_from_slice(b"G1");
                        put_xy(b, q);
                        b.extend_from_slice(b" E");
                        put_fixed(b, e, 5);
                        b.push(b'\n');
                        e_sum += e;
                        prev = q;
                    }
                    crate::arcfit::Seg::Arc {
                        end,
                        center,
                        ccw,
                        len,
                    } => {
                        let e = line_e(len);
                        b.extend_from_slice(if ccw { b"G3" } else { b"G2" });
                        put_xy(b, end);
                        b.extend_from_slice(b" I");
                        put_fixed(b, e_units_mm(center[0]), 3);
                        b.extend_from_slice(b" J");
                        put_fixed(b, e_units_mm(center[1]), 3);
                        b.extend_from_slice(b" E");
                        put_fixed(b, e, 5);
                        b.push(b'\n');
                        e_sum += e;
                        prev = end;
                    }
                }
            }
        } else {
            for &q in pts.iter().skip(1) {
                let len = prev.dist_mm(q);
                let e = line_e(len);
                if e <= 0 {
                    continue;
                }
                b.extend_from_slice(b"G1");
                put_xy(b, q);
                b.extend_from_slice(b" E");
                put_fixed(b, e, 5);
                b.push(b'\n');
                e_sum += e;
                prev = q;
            }
        }
        if let Some(slot) = chunk.e_units.get_mut(usize::from(p.tool.max(1) - 1)) {
            *slot += e_sum;
        }
        if !spiral && cur_z != z && !lifted_bead {
            b.extend_from_slice(b"G1 Z");
            put_fixed(b, z, 3);
            b.extend_from_slice(b" F");
            put_int(b, z_feed);
            b.push(b'\n');
            cur_z = z;
            speed_feed = -1;
        }
        if lifted_bead {
            b.extend_from_slice(b"G1 Z");
            put_fixed(b, z, 3);
            b.extend_from_slice(b" F");
            put_int(b, z_feed);
            b.push(b'\n');
            speed_feed = -1;
        }
        // Wipe on loops: a short move into the part before the nozzle leaves a closed outer wall.
        if wipe_loops
            && !spiral
            && p.feature == Feature::OuterWall
            && pts.len() > 3
            && is_loop(pts)
            && let Some(inward) = inward_wipe_point(pts, prev)
        {
            b.extend_from_slice(b"G1");
            put_xy(b, inward);
            b.push(b'\n');
            prev = inward;
        }
        cursor = Some(prev);
        last_pts = pts;
        last_was_loop = wipes_forward(pts, p.feature);
    }
    if let Some(changed) = tower_block {
        close_tower_block(b, changed, c);
    }
    // A block for the end of the layer: retracted and out of the object's label, then primed again, since
    // every chunk ends unretracted.
    if pending_lift.is_some() {
        write_normal_lift(b, z, z_feed);
    }
    for (_, text) in blocks.iter().filter(|(s, _)| *s == crate::timelapse::Spot::End) {
        let primed = !retracted && style.active(retract);
        if primed {
            retract_move(b, style, -retract, retract_feed);
        }
        if let (Some(lb), Some(prev)) = (labels.as_ref(), open_object.take()) {
            for t in [lb.comment_end(prev), lb.fw_end(prev)].into_iter().flatten() {
                b.extend_from_slice(t.as_bytes());
            }
        }
        if lift_ok && style.active(retract) {
            write_eager_lift(b, &rc, Lift::of_block(&rc), cursor, cur_z, hop, z_feed);
        }
        push_lines(b, text);
        if crate::timelapse::moves_z(text) || (lift_ok && style.active(retract)) {
            b.extend_from_slice(b"G1 Z");
            put_fixed(b, cur_z, 3);
            b.extend_from_slice(b" F");
            put_int(b, z_feed);
            b.push(b'\n');
        }
        if primed {
            retract_move(b, style, retract, deretract_feed);
        }
    }
    if let Some(lb) = labels.as_ref()
        && let Some(prev) = open_object
    {
        // Every chunk closes its label, so chunks concatenate.
        if let Some(t) = lb.comment_end(prev) {
            b.extend_from_slice(t.as_bytes());
        }
        if let Some(t) = lb.fw_end(prev) {
            b.extend_from_slice(t.as_bytes());
        }
    }
    if let Some(p) = smoothing.as_ref() {
        chunk.bytes = crate::equalizer::apply(&chunk.bytes, p);
    }
    if absolute_e_mode(c) {
        chunk.bytes = absolute_e(&chunk.bytes, e_reset_line(flavor));
    }
    if crate::firmware::truthy(c, "gcode_comments") {
        chunk.bytes = add_comments(&chunk.bytes);
    }
    #[allow(clippy::cast_possible_truncation, reason = "seconds of a layer")]
    let change_f32 = change_time as f32;
    let mut tools: Vec<u8> = l.paths.iter().map(|p| p.tool.max(1)).collect();
    tools.sort_unstable();
    tools.dedup();
    let marker = crate::firmware::layer_marker(l.time_s + change_f32, &chunk.e_units, &tools);
    chunk.bytes.extend_from_slice(marker.as_bytes());
    chunk.change_time_s = f64::from(change_f32);
    chunk.error = error;
    chunk
}

/// The lift height (thousandths of a mm), whether a travel at height `zmm` lifts (`retract_lift_above` and
/// `_below`), the extra length on unretract and the unretract feed of a retraction config.
fn lift_and_restart(rc: &PrintConfig, zmm: f64) -> (i64, bool, i64, i64) {
    let hop = if rc.z_hop > 0.0 {
        e_units(rc.z_hop) / 100
    } else {
        0
    };
    let lift_ok = hop > 0
        && zmm >= rc.retract_lift_above
        && (rc.retract_lift_below <= 0.0 || zmm <= rc.retract_lift_below);
    let deretract = if rc.deretraction_speed > 0.0 {
        rc.deretraction_speed
    } else {
        rc.retraction_speed
    };
    (hop, lift_ok, e_units(rc.retract_restart_extra), feed(deretract))
}

/// What a wipe reads (Orca: `Wipe`, `GCode::retract`).
struct Wipe<'a> {
    /// Where the nozzle is.
    cursor: Point,
    /// The last extrusion's points; a closed loop repeats its first point.
    path: &'a [Point],
    /// Wipe on along the path from its second point (a loop) rather than back along it.
    forward: bool,
    /// The retraction length in E units.
    retract: i64,
    retract_feed: i64,
    /// Share of the retraction done fast before the wipe, 0 to 1.
    before: f64,
    distance_mm: f64,
    speed_mm_s: f64,
}

/// The wipe speed in mm/s: the speed of the extrusion just made when `role_based_wipe_speed` is on (it
/// is by default), else `wipe_speed` (mm/s, or a percent of the travel speed, 80 by default); never under 10.
fn wipe_speed_mm_s(c: &PrintConfig, current_feed: i64) -> f64 {
    #[allow(clippy::cast_precision_loss, reason = "feed rates are small")]
    let role = if current_feed > 0 {
        Some(current_feed as f64 / 60.0)
    } else {
        None
    };
    let based = match c.raw.get("role_based_wipe_speed") {
        Some(serde_json::Value::Bool(v)) => *v,
        Some(serde_json::Value::String(t)) => t != "0" && !t.eq_ignore_ascii_case("false"),
        Some(serde_json::Value::Number(n)) => n.as_f64().is_some_and(|v| v != 0.0),
        _ => true,
    };
    let absolute = match c.raw.get("wipe_speed") {
        Some(v) => crate::config::float_or_percent(v, c.travel_speed).unwrap_or(0.8 * c.travel_speed),
        None => 0.8 * c.travel_speed,
    };
    let speed = if based { role.unwrap_or(absolute) } else { absolute };
    speed.max(10.0)
}

/// a retraction that wipes along `path` from `at` when wipe is on and there is a path (orca's
/// `GCode::retract`), else a plain one; the wipe's result when it wiped
fn retract_wiping(
    b: &mut Vec<u8>,
    style: Retraction,
    (rc, c): (&PrintConfig, &PrintConfig),
    (at, path, forward): (Point, &[Point], bool),
    (retract, retract_feed): (i64, i64),
    speed_feed: i64,
) -> Option<Wiped> {
    if !(rc.wipe && rc.wipe_distance > 0.0 && path.len() >= 2) {
        retract_move(b, style, -retract, retract_feed);
        return None;
    }
    Some(wipe_retract(
        b,
        style,
        &Wipe {
            cursor: at,
            path,
            forward,
            retract,
            retract_feed,
            before: rc.raw_number("retract_before_wipe", 100.0).clamp(0.0, 100.0) / 100.0,
            distance_mm: rc.wipe_distance,
            speed_mm_s: wipe_speed_mm_s(c, speed_feed),
        },
    ))
}

/// What the wipe left behind.
struct Wiped {
    /// The feed rate the writer is left at, mm/min.
    feed: i64,
    /// where the nozzle stops
    end: Point,
}

/// Retracts the way Orca does with wipe on (`GCode::retract`, `Wipe::calculateWipeRetractionLengths`,
/// `Wipe::wipe`): the share before the wipe goes first at the retraction speed, then the nozzle follows the
/// last path for `wipe_distance` at the wipe speed while the rest of the retraction, as much as the retraction
/// speed allows in that time, comes off along it; whatever is left is retracted after.
fn wipe_retract(b: &mut Vec<u8>, style: Retraction, w: &Wipe<'_>) -> Wiped {
    // The points the nozzle goes through: from where it is, along the path.
    let mut pts: Vec<Point> = vec![w.cursor];
    if w.forward {
        pts.extend(w.path.iter().skip(1).copied());
    } else {
        pts.extend(w.path.iter().rev().skip(1).copied());
    }
    // The wipe path ends `distance_mm` from its start.
    let mut walk: Vec<(Point, f64)> = Vec::new();
    let mut left = w.distance_mm;
    for pair in pts.windows(2) {
        let [a, z] = pair else { continue };
        let len = a.dist_mm(*z);
        if len <= left {
            walk.push((*z, len));
            left -= len;
        } else {
            let t = left / len;
            #[allow(clippy::cast_possible_truncation, reason = "a point between two i32 points")]
            let p = Point::new(
                (f64::from(a.x) + (f64::from(z.x) - f64::from(a.x)) * t).round() as i32,
                (f64::from(a.y) + (f64::from(z.y) - f64::from(a.y)) * t).round() as i32,
            );
            walk.push((p, left));
            left = 0.0;
        }
        if left <= 1e-9 {
            break;
        }
    }
    let path_mm: f64 = walk.iter().map(|s| s.1).sum();
    let total = e_mm(w.retract);
    // How much comes off before and during the wipe.
    let mut before = total * w.before;
    let remaining = total - before;
    let mut during = 0.0;
    if remaining > EPS_E {
        #[allow(clippy::cast_precision_loss, reason = "feed rates are small")]
        let feed_mm_s = w.retract_feed as f64 / 60.0;
        let possible = feed_mm_s * path_mm / w.speed_mm_s;
        if possible > EPS_E {
            if possible - remaining > EPS_E {
                during = remaining;
            } else {
                before += remaining - possible;
                during = possible;
            }
        } else {
            // Nothing to gain along the path: all of it comes off first.
        }
    }
    let mut retracted = 0.0;
    if style.firmware {
        // The firmware does the whole retraction in one command; the wipe moves carry no E.
        retract_move(b, style, -1, w.retract_feed);
        (before, during, retracted) = (0.0, 0.0, total);
    } else if before > EPS_E {
        retract_move(b, style, -e_units(before), w.retract_feed);
        retracted += before;
    }
    let _ = before;
    b.extend_from_slice(b";WIPE_START\n");
    let feed = feed(w.speed_mm_s);
    b.extend_from_slice(b"G1 F");
    put_int(b, feed);
    b.push(b'\n');
    let span = path_mm.max(1e-6);
    let end = walk.last().map_or(w.cursor, |s| s.0);
    for (p, len) in walk {
        let de = during * len / span;
        b.extend_from_slice(b"G1");
        put_xy(b, p);
        if de.abs() > f64::EPSILON {
            b.extend_from_slice(b" E");
            put_fixed(b, -e_units(de), 5);
            retracted += de;
        }
        b.push(b'\n');
    }
    b.extend_from_slice(b";WIPE_END\n");
    // Whatever the wipe did not take, as long as it is worth a move.
    let rest = total - retracted;
    if rest > EPS_E {
        retract_move(b, style, -e_units(rest), w.retract_feed);
    }
    Wiped { feed, end }
}

/// Orca's `EPSILON`: retraction lengths below it count as nothing, mm.
const EPS_E: f64 = 1e-4;

/// Appends `text` as lines, ending with a newline; nothing for empty text.
/// [`push_lines`] for a `String`.
fn push_text(s: &mut String, text: &str) {
    if !text.is_empty() {
        s.push_str(text);
        if !text.ends_with('\n') {
            s.push('\n');
        }
    }
}

fn push_lines(b: &mut Vec<u8>, text: &str) {
    if text.is_empty() {
        return;
    }
    b.extend_from_slice(text.as_bytes());
    if !text.ends_with('\n') {
        b.push(b'\n');
    }
}

/// How the flavor and the profile write a retraction (`GCodeWriter::_retract`, `unretract`): an `E` move, or
/// firmware retraction (`G10` and `G11`, `G22` and `G23` on Machinekit), with `M103` and `M101` round the
/// extruder on `MakerWare` and `Sailfish`.
#[derive(Clone, Copy)]
struct Retraction {
    flavor: GcodeFlavor,
    firmware: bool,
    /// Absolute extruder distances on a flavor that takes `G92 E0` (`GCodeWriter::reset_e`): a firmware
    /// unretraction is followed by one.
    reset_e: bool,
}

impl Retraction {
    fn of(c: &PrintConfig, flavor: GcodeFlavor) -> Self {
        Self {
            flavor,
            firmware: crate::firmware::truthy(c, "use_firmware_retraction"),
            reset_e: absolute_e_mode(c) && takes_e_reset(flavor),
        }
    }

    /// Whether the printer is asked to retract at all: a length, or the firmware's own.
    fn active(self, length: i64) -> bool {
        length > 0 || self.firmware
    }

    /// `M103` after a retraction and `M101` before an unretraction: `MakerWare` only.
    fn extruder_toggle(self) -> bool {
        self.flavor == GcodeFlavor::MakerWare
    }
}

/// Whether the flavor takes `G92 E0` (`GCodeWriter::reset_e` writes none on Mach3, `MakerWare` and `Sailfish`).
fn takes_e_reset(flavor: GcodeFlavor) -> bool {
    !matches!(
        flavor,
        GcodeFlavor::Mach3 | GcodeFlavor::MakerWare | GcodeFlavor::Sailfish
    )
}

/// A retraction (`e` below 0) or an unretraction (above 0) at feed rate `f`.
fn retract_move(b: &mut Vec<u8>, style: Retraction, e: i64, f: i64) {
    if e > 0 && style.extruder_toggle() {
        b.extend_from_slice(b"M101 ; extruder on\n");
    }
    if style.firmware {
        let machinekit = style.flavor == GcodeFlavor::Machinekit;
        match (e < 0, machinekit) {
            (true, false) => b.extend_from_slice(b"G10 ; retract\n"),
            (true, true) => b.extend_from_slice(b"G22 ; retract\n"),
            (false, false) => b.extend_from_slice(b"G11 ; unretract\n"),
            (false, true) => b.extend_from_slice(b"G23 ; unretract\n"),
        }
        if e > 0 && style.reset_e {
            b.extend_from_slice(b"G92 E0\n");
        }
    } else {
        b.extend_from_slice(b"G1 E");
        put_fixed(b, e, 5);
        b.extend_from_slice(b" F");
        put_int(b, f);
        b.push(b'\n');
    }
    if e < 0 && style.extruder_toggle() {
        b.extend_from_slice(b"M103 ; extruder off\n");
    }
}

/// The point one nozzle width behind `start`, against the way the loop goes on to `next`.
fn before_start(start: Point, next: Point) -> Option<Point> {
    let (dx, dy) = (next.x_mm() - start.x_mm(), next.y_mm() - start.y_mm());
    let len = dx.m_hypot(dy);
    (len > 1e-6).then(|| {
        Point::from_mm(
            start.x_mm() - dx / len * APPROACH_MM,
            start.y_mm() - dy / len * APPROACH_MM,
        )
    })
}

/// How far before a loop's start the nozzle lands when it wipes before an external loop, mm.
const APPROACH_MM: f64 = 0.4;

/// How far the nozzle moves into the part at the end of a wall loop, mm.
const LOOP_WIPE_MM: f64 = 0.1;

/// The point [`LOOP_WIPE_MM`] into the part from `end`, the last point of the closed loop
/// `pts`: to the left of the way it was going for a counterclockwise loop, to the right for a clockwise one.
fn inward_wipe_point(pts: &[Point], end: Point) -> Option<Point> {
    let before = pts.iter().rev().skip(1).find(|q| q.dist_mm(end) > 0.02)?;
    let (dx, dy) = (end.x_mm() - before.x_mm(), end.y_mm() - before.y_mm());
    let len = dx.m_hypot(dy);
    if len < 1e-9 {
        return None;
    }
    let side = if crate::geom::area2(pts) >= 0 { 1.0 } else { -1.0 };
    let (nx, ny) = (-dy / len * side, dx / len * side);
    Some(Point::from_mm(
        end.x_mm() + nx * LOOP_WIPE_MM,
        end.y_mm() + ny * LOOP_WIPE_MM,
    ))
}

/// The most a combed route may be longer than the straight travel.
#[derive(Debug, Clone, Copy)]
enum Detour {
    Mm(f64),
    Percent(f64),
}

/// `max_travel_detour_distance`: mm, or a percent of the travel; 0 means no limit.
fn detour_limit(cfg: &PrintConfig) -> Detour {
    let text = match cfg.raw.get("max_travel_detour_distance") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(a)) => a.first().and_then(|v| v.as_str()).unwrap_or("0").to_owned(),
        Some(v) => v.to_string(),
        None => "0".to_owned(),
    };
    match text.trim().strip_suffix('%') {
        Some(p) => Detour::Percent(p.trim().parse().unwrap_or(0.0)),
        None => Detour::Mm(text.trim().parse().unwrap_or(0.0)),
    }
}

/// How far a fitted arc may stray from the points it replaces, mm. Orca's
/// `LayerRegion::simplify_path` and `Layer::simplify_support` pick it per role:
/// sparse infill 0.04, support 0.0375, everything else the `resolution` setting.
fn arc_tolerance(c: &PrintConfig, feature: Feature) -> f64 {
    match feature {
        Feature::SparseInfill => 0.04,
        Feature::Support | Feature::SupportInterface => 0.0375,
        _ => c
            .raw
            .get("resolution")
            .and_then(|v| match v {
                serde_json::Value::Number(n) => n.as_f64(),
                serde_json::Value::String(t) => t.trim().parse().ok(),
                _ => None,
            })
            .filter(|r| *r > 0.0)
            .unwrap_or(0.012),
    }
}

/// Thousandths of a millimeter, for an arc's center offset.
#[allow(
    clippy::cast_possible_truncation,
    reason = "offsets are far below 2^40 thousandths"
)]
fn e_units_mm(mm: f64) -> i64 {
    (mm * 1000.0).round() as i64
}

fn put_xy(b: &mut Vec<u8>, p: Point) {
    // Ultimaker writes the second print core's moves less its nozzle offset (griffin.rs).
    let p = crate::griffin::shifted(p);
    b.extend_from_slice(b" X");
    put_fixed(b, round_div(i64::from(p.x), 10), 3);
    b.extend_from_slice(b" Y");
    put_fixed(b, round_div(i64::from(p.y), 10), 3);
}

fn round_div(v: i64, d: i64) -> i64 {
    (v + d / 2).div_euclid(d)
}

/// Writes an integer.
fn put_int(b: &mut Vec<u8>, v: i64) {
    let mut buf = [0u8; 20];
    let mut i = buf.len();
    let neg = v < 0;
    let mut u = v.unsigned_abs();
    loop {
        i -= 1;
        if let Some(slot) = buf.get_mut(i) {
            #[allow(clippy::cast_possible_truncation, reason = "a single digit")]
            {
                *slot = b'0' + (u % 10) as u8;
            }
        }
        u /= 10;
        if u == 0 || i == 0 {
            break;
        }
    }
    if neg {
        b.push(b'-');
    }
    b.extend_from_slice(buf.get(i..).unwrap_or(&[]));
}

/// Writes `v / 10^decimals` with trailing zeros removed.
fn put_fixed(b: &mut Vec<u8>, v: i64, decimals: u32) {
    let scale = 10i64.pow(decimals);
    if v < 0 {
        b.push(b'-');
    }
    let u = v.unsigned_abs();
    let scale_u = scale.unsigned_abs();
    #[allow(clippy::cast_possible_wrap, reason = "quotient of an i64 magnitude")]
    put_int(b, (u / scale_u) as i64);
    let mut frac = u % scale_u;
    if frac == 0 {
        return;
    }
    let mut digits = decimals;
    while frac.is_multiple_of(10) {
        frac /= 10;
        digits -= 1;
    }
    b.push(b'.');
    let mut buf = [b'0'; 20];
    let mut i = digits as usize;
    while i > 0 {
        i -= 1;
        if let Some(slot) = buf.get_mut(i) {
            #[allow(clippy::cast_possible_truncation, reason = "a single digit")]
            {
                *slot = b'0' + (frac % 10) as u8;
            }
        }
        frac /= 10;
    }
    b.extend_from_slice(buf.get(..digits as usize).unwrap_or(&[]));
}

/// Whether a wall path is a closed loop: it ends within a millimeter of its start (the seam gap leaves the
/// end a little short of it).
/// a loop of walls, skirt or brim, which the wipe follows on past its start
pub(crate) fn wipes_forward(pts: &[Point], f: Feature) -> bool {
    is_loop(pts)
        && matches!(
            f,
            Feature::OuterWall | Feature::InnerWall | Feature::OverhangWall | Feature::Skirt | Feature::Brim
        )
}

pub(crate) fn is_loop(pts: &[Point]) -> bool {
    pts.len() > 2
        && match (pts.first(), pts.last()) {
            (Some(a), Some(b)) => a.dist_mm(*b) < 1.0,
            _ => false,
        }
}

/// Orca's lift kinds (`LiftType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lift {
    Normal,
    Slope,
    Spiral,
}

impl Lift {
    /// The lift of a travel that retracts (Orca `GCode::needs_retraction`): Auto Lift spirals when the travel's
    /// start crosses an overhang (`over`) and slopes otherwise, the others are their own kind
    /// (`GCode::to_lift_type`).
    fn of_travel(rc: &PrintConfig, over: impl FnOnce() -> bool) -> Self {
        match z_hop_kind(rc).as_str() {
            "Spiral Lift" => Lift::Spiral,
            "Auto Lift" if over() => Lift::Spiral,
            "Slope Lift" | "Auto Lift" => Lift::Slope,
            _ => Lift::Normal,
        }
    }

    /// The lift at a layer change (Orca `GCode::change_layer`): Auto Lift spirals, the others are their own kind.
    fn of_layer_change(rc: &PrintConfig) -> Self {
        match z_hop_kind(rc).as_str() {
            "Spiral Lift" | "Auto Lift" => Lift::Spiral,
            "Slope Lift" => Lift::Slope,
            _ => Lift::Normal,
        }
    }

    /// The lift made at once before custom G-code inside or at the start of a layer (Orca `GCode::retract` with
    /// `apply_instantly`, `GCodeWriter::eager_lift`): a spiral unless the kind is Normal Lift.
    fn of_block(rc: &PrintConfig) -> Self {
        match z_hop_kind(rc).as_str() {
            "Spiral Lift" | "Auto Lift" | "Slope Lift" => Lift::Spiral,
            _ => Lift::Normal,
        }
    }
}

/// A plain lift straight up to `z_to` (thousandths).
fn write_normal_lift(b: &mut Vec<u8>, z_to: i64, z_feed: i64) {
    b.extend_from_slice(b"G1 Z");
    put_fixed(b, z_to, 3);
    b.extend_from_slice(b" F");
    put_int(b, z_feed);
    b.push(b'\n');
}

/// The radius of a spiral lift of `hop_mm` (Orca `GCodeWriter`: one turn at the `travel_slope` angle).
fn spiral_radius(rc: &PrintConfig, hop_mm: f64) -> f64 {
    let slope = crate::motion::raw_f(rc, "travel_slope")
        .unwrap_or(3.0)
        .to_radians();
    hop_mm / (std::f64::consts::TAU * slope.m_atan())
}

/// Orca's spiral lift (`GCodeWriter::_spiral_travel_to_z`): one counterclockwise turn from `from` around the
/// point `ij` (mm) away, climbing from `z_from` to `z_to` (thousandths) at the Z feed rate. With arc fitting on
/// it is one `G3 ... P1` arc; otherwise short moves round the circle, their count set by the profile's
/// resolution (8 at 0.01 mm, 4 to 16).
fn write_spiral_lift(b: &mut Vec<u8>, rc: &PrintConfig, from: Point, ij: [f64; 2], z: [i64; 2], z_feed: i64) {
    let [i, j] = ij;
    let [z_from, z_to] = z;
    // Orca's wording with `gcode_comments` (GCodeWriter::_spiral_travel_to_z).
    let comments = crate::firmware::truthy(rc, "gcode_comments");
    if crate::firmware::truthy(rc, "enable_arc_fitting") {
        b.extend_from_slice(if comments {
            b"G17 ; XY plane for arc\nG3 Z"
        } else {
            b"G17\nG3 Z"
        });
        put_fixed(b, z_to, 3);
        #[allow(
            clippy::cast_possible_truncation,
            reason = "offsets of a few mm in thousandths"
        )]
        let (ti, tj) = ((i * 1000.0).round() as i64, (j * 1000.0).round() as i64);
        b.extend_from_slice(b" I");
        put_fixed(b, ti, 3);
        b.extend_from_slice(b" J");
        put_fixed(b, tj, 3);
        b.extend_from_slice(b" P1 F");
        put_int(b, z_feed);
        if comments {
            b.extend_from_slice(b" ; spiral lift Z");
        }
        b.push(b'\n');
        return;
    }
    let resolution = crate::motion::raw_f(rc, "resolution")
        .filter(|r| *r > 0.0)
        .unwrap_or(0.012);
    #[allow(clippy::cast_possible_truncation, reason = "a small count")]
    let segments = ((8.0 * 0.01 / resolution).round() as i64).clamp(4, 16);
    let (px, py) = (from.x_mm(), from.y_mm());
    let (cx, cy) = (px + i, py + j);
    let radius = i.m_hypot(j);
    let a0 = (py - cy).m_atan2(px - cx);
    if comments {
        b.extend_from_slice(b";spiral lift Z\n");
    }
    b.extend_from_slice(b"G1 F");
    put_int(b, z_feed);
    b.push(b'\n');
    for k in 1..segments {
        #[allow(clippy::cast_precision_loss, reason = "a small count")]
        let t = k as f64 / segments as f64;
        let a = a0 + std::f64::consts::TAU * t;
        b.extend_from_slice(b"G1");
        put_xy(
            b,
            Point::from_mm(cx + radius * a.m_cos(), cy + radius * a.m_sin()),
        );
        b.extend_from_slice(b" Z");
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_precision_loss,
            reason = "z in thousandths"
        )]
        put_fixed(b, z_from + ((z_to - z_from) as f64 * t).round() as i64, 3);
        b.push(b'\n');
    }
    b.extend_from_slice(b"G1");
    put_xy(b, from);
    b.extend_from_slice(b" Z");
    put_fixed(b, z_to, 3);
    b.push(b'\n');
}

/// Orca's lift for a travel from `from` to `to` (`GCodeWriter::travel_to_xyz` with a lift to make), up `hop`
/// from the layer's `z` (thousandths): a spiral turning to the travel's left, a slope ramp along it, or a plain
/// lift. Returns the height the travel itself climbs to when the lift rides on it (a slope too short for its
/// ramp).
#[allow(
    clippy::too_many_arguments,
    reason = "the lift's geometry and the writer's settings"
)]
fn write_lift(
    b: &mut Vec<u8>,
    rc: &PrintConfig,
    kind: Lift,
    from: Point,
    to: Point,
    z: i64,
    hop: i64,
    travel_feed: i64,
    z_feed: i64,
) -> Option<i64> {
    let (dx, dy) = (to.x_mm() - from.x_mm(), to.y_mm() - from.y_mm());
    let len = dx.m_hypot(dy);
    match kind {
        Lift::Spiral if len > 0.0 => {
            #[allow(clippy::cast_precision_loss, reason = "z in thousandths")]
            let r = spiral_radius(rc, hop as f64 / 1000.0);
            write_spiral_lift(b, rc, from, [-dy / len * r, dx / len * r], [z, z + hop], z_feed);
            None
        }
        Lift::Slope if len > 0.0 => match slope_point(rc, from, to) {
            Some(mid) => {
                // The ramp is part of the travel and runs at the travel speed.
                b.extend_from_slice(b"G1");
                put_xy(b, mid);
                b.extend_from_slice(b" Z");
                put_fixed(b, z + hop, 3);
                b.extend_from_slice(b" F");
                put_int(b, travel_feed);
                b.push(b'\n');
                None
            }
            None => Some(z + hop),
        },
        _ => {
            write_normal_lift(b, z + hop, z_feed);
            None
        }
    }
}

/// Orca's lift made at once before custom G-code (`GCodeWriter::eager_lift`): for a spiral, one around the
/// point beside the nozzle on +X when the nozzle's place is known, else straight up.
fn write_eager_lift(
    b: &mut Vec<u8>,
    rc: &PrintConfig,
    kind: Lift,
    at: Option<Point>,
    z: i64,
    hop: i64,
    z_feed: i64,
) {
    match at.filter(|_| kind == Lift::Spiral) {
        Some(from) => {
            #[allow(clippy::cast_precision_loss, reason = "z in thousandths")]
            let r = spiral_radius(rc, hop as f64 / 1000.0);
            write_spiral_lift(b, rc, from, [r, 0.0], [z, z + hop], z_feed);
        }
        None => write_normal_lift(b, z + hop, z_feed),
    }
}

/// `initial_layer_travel_speed` in mm/s: a number, or a percent of `travel_speed` (100 percent by default).
pub(crate) fn initial_layer_travel_speed(c: &PrintConfig) -> f64 {
    c.raw
        .get("initial_layer_travel_speed")
        .and_then(|v| crate::config::float_or_percent(v, c.travel_speed))
        .unwrap_or(c.travel_speed)
}

/// `retract_lift_enforce`: on which surfaces a retraction may lift.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LiftEnforce {
    All,
    Top,
    Bottom,
    TopAndBottom,
}

fn lift_enforce(cfg: &PrintConfig) -> LiftEnforce {
    let text = match cfg.raw.get("retract_lift_enforce") {
        Some(serde_json::Value::String(s)) => s.as_str(),
        Some(serde_json::Value::Array(a)) => a.first().and_then(|v| v.as_str()).unwrap_or(""),
        _ => "",
    };
    match text {
        "Top Only" => LiftEnforce::Top,
        "Bottom Only" => LiftEnforce::Bottom,
        "Top and Bottom" => LiftEnforce::TopAndBottom,
        _ => LiftEnforce::All,
    }
}

/// Whether a retraction lifts here (Orca `GCode::retract`): always for all surfaces; on the first layer for
/// bottom only and top and bottom; after top surface or ironing for top only and top and bottom; else never.
fn lift_allowed(cfg: &PrintConfig, first_layer: bool, last_fill: Option<Feature>) -> bool {
    match lift_enforce(cfg) {
        LiftEnforce::All => true,
        LiftEnforce::Bottom | LiftEnforce::TopAndBottom if first_layer => true,
        LiftEnforce::Top | LiftEnforce::TopAndBottom => {
            matches!(last_fill, Some(Feature::TopSurface | Feature::Ironing))
        }
        LiftEnforce::Bottom => false,
    }
}

/// Whether a filament lifts with Auto Lift, so the slice keeps the overhangs its travels spiral over.
pub(crate) fn auto_lift(cfg: &PrintConfig) -> bool {
    cfg.z_hop > 0.0
        && match cfg.raw.get("z_hop_types") {
            Some(serde_json::Value::Array(a)) => a.iter().any(|v| v.as_str() == Some("Auto Lift")),
            Some(serde_json::Value::String(s)) => s.split(',').any(|k| k.trim() == "Auto Lift"),
            _ => false,
        }
}

/// Whether the start of a travel from `from` toward `to` crosses an overhang (orca `is_through_overhang`):
/// the travel cut to the length a slope lift climbs over, at the largest lift of any filament.
fn over_overhang(
    c: &PrintConfig,
    rc: &PrintConfig,
    hangs: &crate::perimeters::Shapes,
    from: Point,
    to: Point,
) -> bool {
    let most = match c.raw.get("z_hop") {
        Some(serde_json::Value::Array(a)) => {
            a.iter().filter_map(serde_json::Value::as_f64).fold(0.0, f64::max)
        }
        _ => c.z_hop,
    }
    .max(rc.z_hop);
    let slope = crate::motion::raw_f(rc, "travel_slope")
        .unwrap_or(3.0)
        .to_radians();
    let reach = most / slope.m_tan();
    let len = from.dist_mm(to);
    let end = if len > reach && len > 0.0 {
        let t = reach / len;
        Point::from_mm(
            from.x_mm() + (to.x_mm() - from.x_mm()) * t,
            from.y_mm() + (to.y_mm() - from.y_mm()) * t,
        )
    } else {
        to
    };
    let (a, b) = (IntPoint::new(from.x, from.y), IntPoint::new(end.x, end.y));
    let side = |p: IntPoint<i32>, q: IntPoint<i32>, r: IntPoint<i32>| -> i64 {
        (i64::from(q.x - p.x) * i64::from(r.y - p.y) - i64::from(q.y - p.y) * i64::from(r.x - p.x)).signum()
    };
    hangs.iter().any(|shape| {
        let inside = |p| {
            shape.first().is_some_and(|o| crate::perimeters::point_in(o, p))
                && !shape.iter().skip(1).any(|h| crate::perimeters::point_in(h, p))
        };
        inside(a)
            || inside(b)
            || shape.iter().any(|ring| {
                (0..ring.len()).any(|i| {
                    let (Some(&c), Some(&d)) = (ring.get(i), ring.get((i + 1) % ring.len())) else {
                        return false;
                    };
                    let boxed = a.x.min(b.x) <= c.x.max(d.x)
                        && c.x.min(d.x) <= a.x.max(b.x)
                        && a.y.min(b.y) <= c.y.max(d.y)
                        && c.y.min(d.y) <= a.y.max(b.y);
                    boxed && side(a, b, c) * side(a, b, d) <= 0 && side(c, d, a) * side(c, d, b) <= 0
                })
            })
    })
}

/// `z_hop_types`: Normal Lift, Slope Lift, Spiral Lift or Auto Lift; Slope Lift (Orca's default) when unset.
fn z_hop_kind(cfg: &PrintConfig) -> String {
    match cfg.raw.get("z_hop_types") {
        // a per-filament list written as one string ("Spiral Lift,Spiral Lift") reads its first entry
        Some(serde_json::Value::String(s)) => s.split(',').next().unwrap_or("").trim().to_owned(),
        Some(serde_json::Value::Array(a)) => a
            .first()
            .and_then(|v| v.as_str())
            .unwrap_or("Slope Lift")
            .to_owned(),
        _ => "Slope Lift".to_owned(),
    }
}

/// Where a slope lift reaches its height along a travel from `from` to `to`: the rise is
/// `travel_slope` degrees from horizontal, and a travel too short for it lifts straight up.
/// Whether lifts are slope lifts (`z_hop_types` Slope Lift, or Auto Lift on a travel).
fn slope_kind(cfg: &PrintConfig) -> bool {
    let kind = z_hop_kind(cfg);
    (kind.contains("Slope") || kind.contains("Auto")) && cfg.z_hop > 0.0
}

fn slope_point(cfg: &PrintConfig, from: Point, to: Point) -> Option<Point> {
    if !slope_kind(cfg) {
        return None;
    }
    let angle = crate::motion::raw_f(cfg, "travel_slope")
        .filter(|a| *a > 0.5 && *a < 90.0)
        .unwrap_or(3.0);
    let run = cfg.z_hop / angle.to_radians().m_tan();
    let dist = from.dist_mm(to);
    if dist <= run + 0.01 {
        return None;
    }
    let t = run / dist;
    Some(Point::from_mm(
        from.x_mm() + (to.x_mm() - from.x_mm()) * t,
        from.y_mm() + (to.y_mm() - from.y_mm()) * t,
    ))
}

/// True when the profile asks for absolute extruder distances (`use_relative_e_distances` off).
pub(crate) fn absolute_e_mode(cfg: &PrintConfig) -> bool {
    cfg.raw.contains_key("use_relative_e_distances")
        && !crate::firmware::truthy(cfg, "use_relative_e_distances")
}

/// The part fan command (`GCodeWriter::set_fan`) for a speed of 0 to 255.
fn fan_cmd(flavor: GcodeFlavor, speed: i64) -> String {
    if speed <= 0 {
        return match flavor {
            GcodeFlavor::MakerWare | GcodeFlavor::Sailfish => "M127\n".to_owned(),
            GcodeFlavor::Griffin | GcodeFlavor::Cheetah => "M107\n".to_owned(),
            _ => "M106 S0\n".to_owned(),
        };
    }
    match flavor {
        GcodeFlavor::MakerWare | GcodeFlavor::Sailfish => "M126\n".to_owned(),
        GcodeFlavor::Mach3 | GcodeFlavor::Machinekit => format!("M106 P{speed}\n"),
        _ => format!("M106 S{speed}\n"),
    }
}

/// The extruder mode line for the start of the file.
fn e_mode_line(cfg: &PrintConfig, flavor: GcodeFlavor) -> Vec<u8> {
    let mut s = String::new();
    if flavor != GcodeFlavor::MakerWare {
        s.push_str("G90\nG21\n");
    }
    // Only these flavors take an extruder mode line, and with absolute distances the extruder is reset.
    if matches!(
        flavor,
        GcodeFlavor::Sprinter
            | GcodeFlavor::RepRapFirmware
            | GcodeFlavor::Marlin
            | GcodeFlavor::Marlin2
            | GcodeFlavor::Bambu
            | GcodeFlavor::Teacup
            | GcodeFlavor::Repetier
            | GcodeFlavor::Smoothie
            | GcodeFlavor::Klipper
    ) {
        if absolute_e_mode(cfg) {
            s.push_str("M82 ; use absolute distances for extrusion\nG92 E0\n");
        } else {
            s.push_str("M83 ; use relative distances for extrusion\n");
        }
    }
    s.into_bytes()
}

/// Closes a bambu tower block: the plain one, or a change's with orca's travel feed, a planner flush and the
/// extruder reset (`WipeTower::tool_change_new`).
fn close_tower_block(b: &mut Vec<u8>, changed: bool, c: &PrintConfig) {
    b.extend_from_slice(b"; WIPE_TOWER_END\n");
    if changed {
        let _ = write!(
            b,
            "G1 F{}\nG4 S0\nG92 E0\n; CP TOOLCHANGE END\n;------------------\n\n\n",
            feed(c.travel_speed)
        );
    }
}

/// Custom g-code as orca's cooling buffer leaves it in a layer (`CoolingBuffer::apply_layer_cooldown`): a `G0`
/// to `G3` line whose `F` equals the feed rate in force loses it, or goes when it moves nothing.
fn strip_feeds(text: &str, mut current: i64) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let is_move = ["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|m| line.starts_with(m));
        let code_end = line.find(';').unwrap_or(line.len());
        let code = line.get(..code_end).unwrap_or("");
        // the `F` word: where it starts and where its number ends
        let word = code.match_indices(" F").map(|(i, _)| i + 1).find(|&i| {
            code.get(i + 1..)
                .is_some_and(|r| r.starts_with(|ch: char| ch.is_ascii_digit() || ch == '.' || ch == '-'))
        });
        let (Some(at), true) = (word, is_move) else {
            out.push_str(line);
            continue;
        };
        let param_end = code
            .get(at..)
            .and_then(|r| r.find([' ', '\t', '\n', '\r']))
            .map_or(code.len(), |k| at + k);
        // orca reads the feed rate with atoi
        let value: i64 = code
            .get(at + 1..param_end)
            .map(|t| {
                t.chars()
                    .take_while(|ch| ch.is_ascii_digit() || *ch == '-')
                    .collect::<String>()
            })
            .and_then(|t| t.parse().ok())
            .unwrap_or(0);
        if value != current {
            current = value;
            out.push_str(line);
            continue;
        }
        // a line that moves nothing goes whole
        let moves = code
            .split_whitespace()
            .skip(1)
            .any(|w| w.starts_with(['X', 'Y', 'Z', 'E']));
        if !moves {
            continue;
        }
        out.push_str(code.get(..at).unwrap_or("").trim_end());
        out.push_str(line.get(param_end..).unwrap_or(""));
    }
    out
}

/// The feed rate the last move line of `bytes` that has an `F` sets (mm/min), `-1` when it is not a whole
/// number (so the next path writes its own), `None` when no move line sets one.
fn last_feed(bytes: &[u8]) -> Option<i64> {
    for line in bytes.split(|&c| c == b'\n').rev() {
        let is_move = [b"G0 ".as_slice(), b"G1 ", b"G2 ", b"G3 "]
            .iter()
            .any(|m| line.starts_with(m));
        if !is_move {
            continue;
        }
        let code = line.split(|&c| c == b';').next().unwrap_or(&[]);
        let Some(word) = code.split(|&c| c == b' ').find_map(|w| w.strip_prefix(b"F")) else {
            continue;
        };
        let text = std::str::from_utf8(word).unwrap_or("");
        return Some(match text.parse::<i64>() {
            Ok(v) => v,
            Err(_) => text
                .parse::<f64>()
                .ok()
                .filter(|v| v.fract() == 0.0 && v.abs() < 1e12)
                .map_or(-1, |v| {
                    #[allow(clippy::cast_possible_truncation, reason = "a whole feed rate")]
                    {
                        v as i64
                    }
                }),
        });
    }
    None
}

/// `E` as integer units of 1e-5 mm from text like `-0.8` or `.0202`.
fn parse_e(s: &str) -> Option<i64> {
    let (neg, s) = s.strip_prefix('-').map_or((false, s), |r| (true, r));
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if frac.len() > 5 || int.len() > 10 {
        return None;
    }
    let mut v: i64 = if int.is_empty() { 0 } else { int.parse().ok()? };
    v *= 100_000;
    if !frac.is_empty() {
        let scale = 10i64.pow(5 - u32::try_from(frac.len()).ok()?);
        v += frac.parse::<i64>().ok()? * scale;
    }
    Some(if neg { -v } else { v })
}

/// The line that zeroes the extruder at the start of an absolute layer chunk. Mach3, `MakerWare` and `Sailfish`
/// never reset it in Orca (`GCodeWriter::reset_e`), so theirs is [`E_CARRY`], which finalize removes, carrying
/// the extruder position on from the layer before.
fn e_reset_line(flavor: GcodeFlavor) -> &'static [u8] {
    if takes_e_reset(flavor) {
        b"G92 E0\n"
    } else {
        b"G92 E0 ;@E\n"
    }
}

/// See [`e_reset_line`]; the line still resets the extruder if finalize never sees it.
pub(crate) const E_CARRY: &[u8] = b"G92 E0 ;@E";

/// Removes the [`E_CARRY`] resets of a whole file and adds to every later extruder position the position
/// the extruder had reached before each of them, so the distances run on through the file as Orca writes them
/// for flavors that never reset the extruder. Positions before the first reset (the start G-code) stay.
pub(crate) fn carry_e(gcode: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(gcode.len());
    let (mut offset, mut last, mut on) = (0i64, 0i64, false);
    for line in gcode.split_inclusive(|&c| c == b'\n') {
        let bare = line.strip_suffix(b"\n").unwrap_or(line);
        if bare == E_CARRY {
            offset = last;
            on = true;
            continue;
        }
        let text = std::str::from_utf8(line).unwrap_or("");
        let is_move = ["G0 ", "G1 ", "G2 ", "G3 "].iter().any(|p| text.starts_with(p));
        if on
            && is_move
            && let Some(i) = text.find(" E")
        {
            let rest = text.get(i + 2..).unwrap_or("");
            let end = rest.find([' ', ';', '\n']).unwrap_or(rest.len());
            if let Some(v) = rest.get(..end).and_then(parse_e) {
                last = v + offset;
                out.extend_from_slice(text.get(..i + 2).unwrap_or("").as_bytes());
                put_fixed(&mut out, last, 5);
                out.extend_from_slice(rest.get(end..).unwrap_or("").as_bytes());
                continue;
            }
        }
        out.extend_from_slice(line);
    }
    out
}

/// Rewrites the relative extrusion of one layer chunk as absolute distances counted from the reset
/// line `reset` at the start of the chunk, so chunks still concatenate.
///
/// Custom G-code in the chunk is often written for relative extrusion (the Bambu Lab blocks switch to `M83`
/// and zero the extruder, indented inside their conditions), so indented lines count, an `M83` becomes `M82`
/// since every later distance is rewritten as a position, and moves between `G91` and `G90`, where the
/// firmware moves E relatively whatever the mode, stay as written.
fn absolute_e(chunk: &[u8], reset: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(chunk.len() + 16);
    out.extend_from_slice(reset);
    let mut pos = 0i64;
    let mut all_relative = false;
    for line in chunk.split_inclusive(|&c| c == b'\n') {
        let text = std::str::from_utf8(line).unwrap_or("");
        let body = text.trim_start_matches([' ', '\t']);
        let indent = text.get(..text.len() - body.len()).unwrap_or("");
        let code = body.split(';').next().unwrap_or("");
        let cmd = code.split_whitespace().next().unwrap_or("");
        // The E word of the line's code, as (start, end) in `body`.
        let e_word = || {
            let i = code.find(" E")? + 2;
            let end = code
                .get(i..)?
                .find([' ', '\t', '\r', '\n'])
                .map_or(code.len(), |n| i + n);
            Some((i, end))
        };
        match cmd {
            "G91" => all_relative = true,
            "G90" => all_relative = false,
            "M83" => {
                out.extend_from_slice(indent.as_bytes());
                out.extend_from_slice(b"M82");
                out.extend_from_slice(body.get(3..).unwrap_or("").as_bytes());
                continue;
            }
            "G92" => {
                if let Some(v) = e_word().and_then(|(i, end)| body.get(i..end)).and_then(parse_e) {
                    pos = v;
                }
            }
            "G0" | "G1" | "G2" | "G3" => {
                if let Some((i, end)) = e_word()
                    && let Some(v) = body.get(i..end).and_then(parse_e)
                {
                    pos += v;
                    if !all_relative {
                        out.extend_from_slice(indent.as_bytes());
                        out.extend_from_slice(body.get(..i).unwrap_or("").as_bytes());
                        put_fixed(&mut out, pos, 5);
                        out.extend_from_slice(body.get(end..).unwrap_or("").as_bytes());
                        continue;
                    }
                }
            }
            _ => {}
        }
        out.extend_from_slice(line);
    }
    out
}

/// Adds the comments verbose G-code has, worded as `OrcaSlicer` words them: `; retract`,
/// `; unretract`, `; perimeter` and `; infill` on extrusions, `; move to first perimeter point`
/// (or infill) on the lift and travel before a feature, `; reset Z after contouring` on the drop.
fn add_comments(chunk: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(chunk);
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let mut notes: Vec<Option<&'static str>> = vec![None; lines.len()];
    let mut travel: Vec<usize> = Vec::new();
    let mut walls = false;
    let mut lifted = false;
    // Inside a spiral lift's segments, which Orca leaves without a comment of their own.
    let mut spiral = false;
    let class = |walls: bool| {
        if walls {
            "move to first perimeter point"
        } else {
            "move to first infill point"
        }
    };
    for (i, line) in lines.iter().enumerate() {
        let body = line.trim_end_matches('\n');
        if body.contains(';') && !body.starts_with(';') {
            continue;
        }
        if body == ";spiral lift Z" {
            spiral = true;
            continue;
        }
        if spiral {
            if body.starts_with("G1 F")
                || (body.starts_with("G1 X") && body.contains(" Z") && !body.contains(" E"))
            {
                continue;
            }
            spiral = false;
        }
        if let Some(t) = body.strip_prefix(";TYPE:") {
            walls = matches!(t, "Outer wall" | "Inner wall" | "Overhang wall");
            for &k in &travel {
                if let Some(n) = notes.get_mut(k) {
                    *n = Some(class(walls));
                }
            }
            travel.clear();
        } else if body.starts_with("G1 E-") {
            if let Some(n) = notes.get_mut(i) {
                *n = Some("retract");
            }
        } else if body.starts_with("G1 E") {
            if let Some(n) = notes.get_mut(i) {
                *n = Some("unretract");
            }
        } else if body.starts_with("G1 X") && !body.contains(" E") && !body.contains(" F") {
            if let Some(n) = notes.get_mut(i) {
                *n = Some("move inwards before travel");
            }
        } else if body.starts_with("G0 ")
            || (body.starts_with("G1 Z") && !lifted && travel.is_empty() && body.contains(" F600"))
        {
            travel.push(i);
            lifted |= body.starts_with("G1 Z");
        } else if body.starts_with("G1 Z") && lifted {
            if let Some(n) = notes.get_mut(i) {
                *n = Some("reset Z after contouring");
            }
            lifted = false;
        } else if body.starts_with("G1 X") && body.contains(" E")
            || body.starts_with("G2 ")
            || body.starts_with("G3 ")
        {
            if let Some(n) = notes.get_mut(i) {
                *n = Some(if walls { "perimeter" } else { "infill" });
            }
            for &k in &travel {
                if let Some(n) = notes.get_mut(k) {
                    *n = Some(class(walls));
                }
            }
            travel.clear();
            lifted = false;
        }
    }
    let mut out = Vec::with_capacity(chunk.len() + chunk.len() / 8);
    for (line, note) in lines.iter().zip(&notes) {
        match note {
            Some(n) if line.ends_with('\n') => {
                out.extend_from_slice(line.trim_end_matches('\n').as_bytes());
                out.extend_from_slice(b" ; ");
                out.extend_from_slice(n.as_bytes());
                out.push(b'\n');
            }
            _ => out.extend_from_slice(line.as_bytes()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn a_change_gcode_that_selects_no_tool_gets_the_tool_command() {
        // Orca's `custom_gcode_changes_tool`: the last tool command at a line start counts.
        assert!(changes_tool("G91\nM400\nT2\nG90\n", "T", 2));
        assert!(changes_tool("  T1 H-1\n", "T", 1));
        assert!(
            !changes_tool("M109 S210 T1\nSM_PRINT_PREEXTRUDE_FILAMENT INDEX=1\n", "T", 1),
            "T in a word is not a tool change"
        );
        assert!(!changes_tool("T1\nT0\n", "T", 1), "the last one wins");
        assert!(!changes_tool("TIMELAPSE_TAKE_FRAME\n", "T", 0));
        assert!(changes_tool("M135 T3\n", "M135 T", 3));
    }

    #[test]
    fn change_time_follows_the_extruder_map() {
        // H2D: filaments 1 and 2 on the left and right nozzle, 3 on the right as well.
        let mut c = PrintConfig::default();
        c.raw
            .insert("nozzle_diameter".into(), serde_json::json!([0.4, 0.4]));
        c.raw.insert("filament_map".into(), serde_json::json!([1, 2, 2]));
        c.raw
            .insert("machine_switch_extruder_time".into(), serde_json::json!(5.6));
        c.raw
            .insert("machine_load_filament_time".into(), serde_json::json!(26));
        c.raw
            .insert("machine_unload_filament_time".into(), serde_json::json!(26));
        let mut k = ChangeClock::new(&c);
        assert!(near(k.change(0), 26.0), "the first load");
        assert!(
            near(k.change(1), 5.6 + 26.0),
            "an empty extruder: switch and load"
        );
        assert!(near(k.change(0), 5.6), "the left nozzle still holds filament 1");
        assert!(
            near(k.change(2), 5.6 + 52.0),
            "the right nozzle held filament 2: unload, load, switch"
        );
        assert!(near(k.change(2), 0.0), "already there");
        // U1: four tools, one filament each, 5 s a change and no loading.
        let mut c = PrintConfig::default();
        c.raw
            .insert("nozzle_diameter".into(), serde_json::json!([0.4, 0.4, 0.4, 0.4]));
        c.raw
            .insert("machine_tool_change_time".into(), serde_json::json!(5));
        let mut k = ChangeClock::new(&c);
        assert!(near(k.change(0), 0.0));
        assert!(near(k.change(3), 5.0));
        assert!(near(k.change(1), 5.0));
        assert!(
            near(tool_change_time(&c, None, b"", None, 0.0), 5.0),
            "the stateless fallback is the switch"
        );
        // One nozzle with an AMS: unload and load, the first unload free.
        let mut c = PrintConfig::default();
        c.raw
            .insert("machine_load_filament_time".into(), serde_json::json!(29));
        c.raw
            .insert("machine_unload_filament_time".into(), serde_json::json!(28));
        let mut k = ChangeClock::new(&c);
        assert!(near(k.change(0), 29.0));
        assert!(near(k.change(1), 57.0));
        assert!(near(tool_change_time(&c, None, b"", None, 0.0), 57.0));
    }

    #[test]
    fn fan_ramps_to_full_and_beds_take_the_highest_filament() {
        let mut c = PrintConfig {
            close_fan_the_first_x_layers: 1,
            ..PrintConfig::default()
        };
        c.raw.insert("full_fan_speed_layer".into(), serde_json::json!(4));
        assert_eq!(fan_ramp(&c, 0), None);
        assert!(fan_ramp(&c, 1).is_some_and(|f| (f - 1.0 / 3.0).abs() < 1e-9));
        assert!(fan_ramp(&c, 2).is_some_and(|f| (f - 2.0 / 3.0).abs() < 1e-9));
        assert_eq!(fan_ramp(&c, 3), None);
        // 100 percent on a quick layer: a third, two thirds, then full.
        (c.fan_max_speed, c.slow_down_layer_time) = (100.0, 1000.0);
        let fans: Vec<i64> = (0..4).map(|i| layer_fan(&c, i, 5.0, 1)).collect();
        assert_eq!(fans, vec![0, 84, 171, 255]);
        // Bed temperature by the highest of the layer's filaments.
        c.raw
            .insert("hot_plate_temp".into(), serde_json::json!([55, 70, 60]));
        assert!((bed_for(&c, "hot_plate_temp", &[1, 3], 55.0) - 55.0).abs() < 1e-9);
        c.raw.insert(
            "bed_temperature_formula".into(),
            serde_json::json!("by_highest_temp"),
        );
        assert!((bed_for(&c, "hot_plate_temp", &[1, 3], 55.0) - 60.0).abs() < 1e-9);
        assert!((bed_for(&c, "hot_plate_temp", &[], 55.0) - 55.0).abs() < 1e-9);
        // Overhang fan on every outer wall at a 0% threshold.
        assert!(!overhang_fan_on_walls(&c));
        c.raw
            .insert("overhang_fan_threshold".into(), serde_json::json!(["0%"]));
        assert!(overhang_fan_on_walls(&c));
    }

    #[test]
    fn layer_fan_as_orca_writes_it() {
        // values from orca 2.4.2 on a cube: min 35, max 90, slow down at 2 s, full cooling at 40 s
        let mut c = PrintConfig {
            close_fan_the_first_x_layers: 1,
            fan_min_speed: 35.0,
            fan_max_speed: 90.0,
            slow_down_layer_time: 2.0,
            fan_cooling_layer_time: 40.0,
            ..PrintConfig::default()
        };
        assert_eq!(layer_fan(&c, 0, 1.0, 1), 0);
        assert_eq!(layer_fan(&c, 3, 1.0, 1), 229);
        // between the two times in whole percents: 62 of 62.5
        assert_eq!(layer_fan(&c, 3, 21.0, 1), 158);
        // slower layers stop the fan unless the filament keeps it on
        assert_eq!(layer_fan(&c, 3, 60.0, 1), 0);
        c.raw.insert(
            "reduce_fan_stop_start_freq".into(),
            serde_json::json!([false, true]),
        );
        assert_eq!(layer_fan(&c, 3, 60.0, 1), 0);
        assert_eq!(layer_fan(&c, 3, 60.0, 2), 89);
        c.raw
            .insert("part_cooling_fan_min_pwm".into(), serde_json::json!(50));
        assert_eq!(layer_fan(&c, 3, 60.0, 2), 127);
        assert_eq!(layer_fan(&c, 3, 60.0, 1), 0);
    }

    fn s(v: i64, d: u32) -> String {
        let mut b = Vec::new();
        put_fixed(&mut b, v, d);
        String::from_utf8(b).unwrap()
    }

    #[test]
    fn fixed_formatting() {
        assert_eq!(s(123_456, 3), "123.456");
        assert_eq!(s(120_000, 3), "120");
        assert_eq!(s(120_500, 3), "120.5");
        assert_eq!(s(5, 3), "0.005");
        assert_eq!(s(-80_000, 5), "-0.8");
        assert_eq!(s(0, 5), "0");
        assert_eq!(s(3_136, 5), "0.03136");
    }

    #[test]
    fn temperatures_follow_the_flavor() {
        let line = |f: GcodeFlavor, wait: bool, tool: Option<u8>| {
            let mut b = Vec::new();
            temperature_line(&mut b, f, 215.0, wait, tool, "");
            String::from_utf8(b).unwrap()
        };
        assert_eq!(line(GcodeFlavor::Marlin2, false, None), "M104 S215\n");
        assert_eq!(line(GcodeFlavor::Marlin, true, Some(1)), "M109 S215 T1\n");
        assert_eq!(line(GcodeFlavor::RepRapFirmware, false, Some(1)), "G10 S215 P1\n");
        assert_eq!(
            line(GcodeFlavor::RepRapFirmware, true, Some(0)),
            "G10 S215 P0\nM116 ; wait for temperature to be reached\n"
        );
        assert_eq!(
            line(GcodeFlavor::Teacup, true, None),
            "M104 S215\nM116 ; wait for temperature to be reached\n"
        );
        assert_eq!(line(GcodeFlavor::Mach3, false, None), "M104 P215\n");
        assert_eq!(
            line(GcodeFlavor::MakerWare, true, None),
            "",
            "MakerWare cannot wait"
        );
    }

    #[test]
    fn custom_gcode_loses_the_feed_rates_that_change_nothing() {
        // orca's cooling buffer: the same feed rate goes from a move, and a move of nothing goes whole
        let text = "G1 X-48.2 F3000\nG1 Z9.2 F3000 ; up\nG1 F3000\n    G1 X1 F3000\nG1 Y128 F9000\nM400\nG1 E2 F9000\n";
        assert_eq!(
            strip_feeds(text, 1200),
            "G1 X-48.2 F3000\nG1 Z9.2 ; up\n    G1 X1 F3000\nG1 Y128 F9000\nM400\nG1 E2\n"
        );
        assert_eq!(strip_feeds("G1 E23.7 F523.843\n", 523), "G1 E23.7\n");
    }

    #[test]
    fn the_fan_and_the_preamble_follow_the_flavor() {
        assert_eq!(fan_cmd(GcodeFlavor::Marlin2, 0), "M106 S0\n");
        assert_eq!(fan_cmd(GcodeFlavor::Marlin2, 128), "M106 S128\n");
        assert_eq!(fan_cmd(GcodeFlavor::Sailfish, 128), "M126\n");
        assert_eq!(fan_cmd(GcodeFlavor::MakerWare, 0), "M127\n");
        assert_eq!(fan_cmd(GcodeFlavor::Mach3, 128), "M106 P128\n");
        let cfg = PrintConfig::default();
        let pre = |f| String::from_utf8(e_mode_line(&cfg, f)).unwrap();
        assert_eq!(
            pre(GcodeFlavor::Marlin2),
            "G90\nG21\nM83 ; use relative distances for extrusion\n"
        );
        assert_eq!(pre(GcodeFlavor::Mach3), "G90\nG21\n");
        assert_eq!(pre(GcodeFlavor::MakerWare), "");
    }

    #[test]
    fn retraction_is_an_e_move_or_the_firmwares_own() {
        let mut b = Vec::new();
        let plain = Retraction {
            flavor: GcodeFlavor::Marlin2,
            firmware: false,
            reset_e: false,
        };
        retract_move(&mut b, plain, -80_000, 1800);
        retract_move(&mut b, plain, 80_000, 1800);
        assert_eq!(String::from_utf8(b).unwrap(), "G1 E-0.8 F1800\nG1 E0.8 F1800\n");
        let mut b = Vec::new();
        let fw = Retraction {
            flavor: GcodeFlavor::Machinekit,
            firmware: true,
            reset_e: false,
        };
        retract_move(&mut b, fw, -80_000, 1800);
        retract_move(&mut b, fw, 80_000, 1800);
        assert_eq!(String::from_utf8(b).unwrap(), "G22 ; retract\nG23 ; unretract\n");
        let mut b = Vec::new();
        let mw = Retraction {
            flavor: GcodeFlavor::MakerWare,
            firmware: false,
            reset_e: false,
        };
        retract_move(&mut b, mw, -80_000, 1800);
        retract_move(&mut b, mw, 80_000, 1800);
        assert_eq!(
            String::from_utf8(b).unwrap(),
            "G1 E-0.8 F1800\nM103 ; extruder off\nM101 ; extruder on\nG1 E0.8 F1800\n"
        );
    }
}
