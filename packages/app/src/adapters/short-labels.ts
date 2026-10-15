// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Short names for long enum values, shown only in a closed select in Print settings, so a select keeps the 128 px
// control column instead of growing or dropping under its label. The open menu, the tooltip and the accessible name
// keep the full name (adapters/settings.ts and the schema's enum labels), and stored values never change. Every
// option whose full name is over the budget has one here, and no two options of one setting share one (tested).
import type { SettingDef } from '@slicerx/contracts'

const SURFACE_PATTERNS = { alignedrectilinear: 'Aligned', archimedeanchords: 'Archimedean', octagramspiral: 'Octagram' }

export const SHORT_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  support_style: { default: 'Default' },
  gap_fill_target: { topbottom: 'Top and bottom' },
  enable_extra_bridge_layer: { external_bridge_only: 'External', internal_bridge_only: 'Internal', apply_to_all: 'All' },
  support_interface_pattern: { rectilinear_interlaced: 'Interlaced' },
  top_surface_pattern: SURFACE_PATTERNS,
  bottom_surface_pattern: SURFACE_PATTERNS,
  internal_solid_infill_pattern: SURFACE_PATTERNS,
  sparse_infill_pattern: { ...SURFACE_PATTERNS, 'lateral-honeycomb': 'Lat. honeycomb' },
  top_surface_expansion_direction: { inward_and_outward: 'Both ways' },
  fuzzy_skin_noise_type: { ridgedmulti: 'Ridged' },
  wall_sequence: { 'inner wall/outer wall': 'Inner first', 'outer wall/inner wall': 'Outer first', 'inner-outer-inner wall': 'Inner/outer/inner' },
  brim_type: { outer_and_inner: 'Outer and inner' },
  seam_slope_type: { all: 'Contour + hole' },
  fuzzy_skin: { all: 'Contour + hole' },
}

/**
 * Selects that keep a wider control than the column's 128 px, where a short name would not read: Counterclockwise,
 * and the wall order Inner/outer/inner, a sequence that loses its meaning when cut.
 */
export const WIDE_SELECTS: Readonly<Record<string, number>> = { wall_direction: 136, wall_sequence: 136 }

/** The name a closed select shows for a value: its short name, else its full one. */
export function shortLabel(def: Pick<SettingDef, 'key'>, value: string, full: string): string {
  return SHORT_LABELS[def.key]?.[value] ?? full
}
