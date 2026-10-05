// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// norn: which settings made a toolpath. A click in Preview gives the path's feature; this maps the
// feature to the few settings that shape it most, in the order a person would reach for them.
import { FEATURE } from '@slicerx/contracts'

export interface FeatureSettings {
  /** The feature in the words the legend uses. */
  name: string
  keys: readonly string[]
}

export const FEATURE_SETTINGS: Readonly<Record<number, FeatureSettings>> = {
  [FEATURE.outerWall]: { name: 'Outer wall', keys: ['outer_wall_speed', 'outer_wall_line_width', 'wall_loops', 'seam_position'] },
  [FEATURE.innerWall]: { name: 'Inner wall', keys: ['wall_loops', 'inner_wall_speed', 'inner_wall_line_width'] },
  [FEATURE.overhangWall]: { name: 'Overhang wall', keys: ['overhang_2_4_speed', 'overhang_1_4_speed', 'enable_support'] },
  [FEATURE.topSurface]: { name: 'Top surface', keys: ['top_shell_layers', 'top_surface_pattern', 'top_surface_speed', 'top_surface_line_width'] },
  [FEATURE.bottomSurface]: { name: 'Bottom surface', keys: ['bottom_shell_layers', 'bottom_surface_pattern', 'initial_layer_speed'] },
  [FEATURE.internalSolid]: { name: 'Solid infill', keys: ['internal_solid_infill_speed', 'top_shell_layers', 'bottom_shell_layers'] },
  [FEATURE.sparseInfill]: { name: 'Sparse infill', keys: ['sparse_infill_density', 'sparse_infill_pattern', 'sparse_infill_speed', 'sparse_infill_line_width'] },
  [FEATURE.bridge]: { name: 'Bridge', keys: ['bridge_speed', 'bridge_flow'] },
  [FEATURE.internalBridge]: { name: 'Internal bridge', keys: ['internal_bridge_speed', 'bridge_flow'] },
  [FEATURE.support]: { name: 'Support', keys: ['enable_support', 'support_type', 'support_threshold_angle', 'support_speed'] },
  [FEATURE.supportInterface]: { name: 'Support interface', keys: ['support_interface_top_layers', 'support_interface_speed', 'enable_support'] },
  [FEATURE.brimSkirt]: { name: 'Brim', keys: ['brim_type', 'brim_width'] },
  [FEATURE.skirt]: { name: 'Skirt', keys: ['skirt_loops', 'skirt_distance'] },
  [FEATURE.ironing]: { name: 'Ironing', keys: ['ironing_type', 'ironing_speed', 'ironing_flow'] },
  [FEATURE.gapFill]: { name: 'Gap fill', keys: ['gap_infill_speed', 'outer_wall_line_width'] },
  [FEATURE.primeTower]: { name: 'Prime tower', keys: ['enable_prime_tower', 'prime_tower_width'] },
  [FEATURE.custom]: { name: 'Custom G-code', keys: [] },
}

export function settingsFor(feature: number): FeatureSettings {
  return FEATURE_SETTINGS[feature] ?? { name: 'Toolpath', keys: [] }
}

/** "4 min less", "1.2 g more" or "the same": the difference a change made, in the unit's own words. */
export function diffText(before: number, after: number, format: (v: number) => string, floor: number): string {
  const d = after - before
  if (Math.abs(d) < floor) return 'the same'
  return `${format(Math.abs(d))} ${d < 0 ? 'less' : 'more'}`
}
