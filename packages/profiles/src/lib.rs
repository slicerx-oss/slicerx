// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The stock printer and process profile data as JSON text: the makers' own machine settings, start
//! and end G-code and process speeds, as `OrcaSlicer` 2.4.2 resolves them. The data files are
//! AGPL-3.0-or-later (see README.md); this crate only embeds them. `sx-settings` reads them through
//! its `stock-profiles` feature. The filament presets and resolved profiles are megabytes and are
//! not embedded: read them from `filaments/` and `resolved/` beside this crate.
//!
//! `cura/ultimaker.json` holds the `UltiMaker` S series, resolved from `UltiMaker` Cura's definitions; it is
//! LGPL-3.0-or-later like Cura (see README.md).

/// `machine.json`: numeric and choice machine settings per printer model.
pub const MACHINE: &str = include_str!("../machine.json");

/// `gcode.json`: start, end, layer change, filament change, pause and time lapse G-code per printer family.
pub const GCODE: &str = include_str!("../gcode.json");

/// `process-speeds.json`: speeds, accelerations and jerk of the makers' process presets per model and tier.
pub const PROCESS_SPEEDS: &str = include_str!("../process-speeds.json");

/// `cura/ultimaker.json`: the `UltiMaker` S series machine settings, print cores, quality presets and G-code
/// families, from `UltiMaker` Cura (LGPL-3.0-or-later).
pub const CURA_ULTIMAKER: &str = include_str!("../cura/ultimaker.json");
