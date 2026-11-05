// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The features the Color tab's feature filament table lists and the setting each one sets (plate/feature-filaments.ts
// reads and writes them). Kept apart, with no imports, so the saved preferences can read it as they load.

export interface FeatureFilamentDef {
  /** The feature's name in the slice report (FEATURE in contracts). */
  feature: string
  label: string
  key: string
  /** A height range may change it too (plate/layer-ranges.ts RANGE_KEYS); the support filaments are plate-wide. */
  byHeight: boolean
}

/** The rows, in print order from the outside in, then support. */
export const FEATURE_FILAMENT_ROWS: readonly FeatureFilamentDef[] = [
  { feature: 'outerWall', label: 'Outer wall', key: 'outer_wall_filament_id', byHeight: true },
  { feature: 'innerWall', label: 'Inner wall', key: 'inner_wall_filament_id', byHeight: true },
  { feature: 'sparseInfill', label: 'Sparse infill', key: 'sparse_infill_filament_id', byHeight: true },
  { feature: 'internalSolid', label: 'Solid infill', key: 'internal_solid_filament_id', byHeight: true },
  { feature: 'topSurface', label: 'Top surface', key: 'top_surface_filament_id', byHeight: true },
  { feature: 'bottomSurface', label: 'Bottom surface', key: 'bottom_surface_filament_id', byHeight: true },
  { feature: 'support', label: 'Support', key: 'support_filament', byHeight: false },
  { feature: 'supportInterface', label: 'Support interface', key: 'support_interface_filament', byHeight: false },
]

/** The settings the table owns: they are not listed as rows anywhere else. */
export const FEATURE_FILAMENT_KEYS: ReadonlySet<string> = new Set(FEATURE_FILAMENT_ROWS.map((r) => r.key))
