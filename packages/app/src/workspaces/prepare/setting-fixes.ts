// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a setting helps with, in the words people search for: "stringing" finds retraction and travel, "elephant foot"
// finds its compensation. Search matches these as well as the setting's name.

/** Print problems, each with the settings that help with it. */
const PROBLEMS: Readonly<Record<string, readonly string[]>> = {
  stringing: ['travel_speed', 'reduce_infill_retraction', 'reduce_crossing_wall', 'ooze_prevention', 'standby_temperature_delta', 'wipe_on_loops', 'role_based_wipe_speed', 'wipe_speed'],
  oozing: ['ooze_prevention', 'standby_temperature_delta', 'wipe_on_loops'],
  'elephant foot': ['elefant_foot_compensation', 'elefant_foot_compensation_layers', 'initial_layer_print_height', 'first_layer_flow_ratio'],
  'first layer squish': ['elefant_foot_compensation', 'initial_layer_print_height', 'first_layer_flow_ratio'],
  warping: ['brim_width', 'brim_type', 'raft_layers', 'draft_shield', 'skirt_loops', 'initial_layer_speed'],
  'lifting corners': ['brim_width', 'brim_type', 'raft_layers'],
  'seam scar': ['seam_position', 'seam_gap', 'seam_slope_conditional', 'seam_slope_type', 'scarf_joint_speed', 'wipe_on_loops', 'staggered_inner_seams'],
  zits: ['seam_position', 'seam_gap', 'seam_slope_conditional', 'seam_slope_type', 'wipe_on_loops', 'wipe_before_external_loop'],
  blobs: ['seam_position', 'seam_gap', 'wipe_on_loops'],
  pillowing: ['top_shell_layers', 'top_shell_thickness', 'top_surface_density', 'top_bottom_infill_wall_overlap', 'sparse_infill_density'],
  'holes in top': ['top_shell_layers', 'top_shell_thickness', 'top_surface_density', 'sparse_infill_density'],
  sagging: ['thick_bridges', 'bridge_flow', 'bridge_speed', 'enable_extra_bridge_layer', 'support_type'],
  'drooping overhangs': ['enable_overhang_speed', 'overhang_4_4_speed', 'extra_perimeters_on_overhangs', 'support_threshold_angle', 'wave_overhangs'],
  curling: ['enable_overhang_speed', 'slowdown_for_curled_perimeters', 'extra_perimeters_on_overhangs', 'wave_overhangs'],
  'part too big': ['xy_contour_compensation', 'xy_hole_compensation', 'elefant_foot_compensation'],
  'holes too small': ['xy_hole_compensation', 'hole_to_polyhole'],
  tolerance: ['xy_contour_compensation', 'xy_hole_compensation', 'hole_to_polyhole', 'precise_outer_wall'],
  fit: ['xy_contour_compensation', 'xy_hole_compensation', 'hole_to_polyhole'],
  'weak part': ['wall_loops', 'sparse_infill_density', 'sparse_infill_pattern', 'top_shell_layers', 'bottom_shell_layers'],
  'layer lines': ['layer_height', 'smart_layer', 'precise_z_height', 'ironing_type'],
  'rough top': ['ironing_type', 'top_surface_pattern', 'top_surface_speed', 'top_shell_layers'],
  'smooth top': ['ironing_type', 'top_surface_pattern'],
  'gaps between lines': ['top_bottom_infill_wall_overlap', 'infill_wall_overlap', 'print_flow_ratio', 'filter_out_gap_fill'],
  'over extrusion': ['print_flow_ratio', 'outer_wall_flow_ratio', 'top_solid_infill_flow_ratio'],
  'under extrusion': ['print_flow_ratio', 'max_volumetric_extrusion_rate_slope', 'outer_wall_speed'],
  'support hard to remove': ['support_top_z_distance', 'support_object_xy_distance', 'support_interface_top_layers', 'support_interface_pattern'],
  'support scars': ['support_top_z_distance', 'support_interface_top_layers', 'support_interface_pattern', 'support_style'],
  'support falls over': ['support_type', 'tree_support_branch_diameter', 'tree_support_wall_count', 'tree_support_brim_width', 'support_base_pattern'],
  'wasted filament': ['flush_into_infill', 'flush_into_objects', 'flush_into_support', 'prime_tower_width'],
  purge: ['flush_into_infill', 'flush_into_objects', 'flush_into_support', 'enable_prime_tower'],
  'color bleed': ['flush_into_objects', 'flush_into_infill', 'enable_prime_tower'],
  'slow print': ['outer_wall_speed', 'sparse_infill_speed', 'travel_speed', 'sparse_infill_density', 'layer_height'],
  vibration: ['default_acceleration', 'outer_wall_acceleration', 'default_jerk'],
  ringing: ['outer_wall_acceleration', 'default_acceleration', 'outer_wall_speed', 'default_jerk'],
}

const BY_KEY: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>()
  for (const [problem, keys] of Object.entries(PROBLEMS)) for (const k of keys) out.set(k, [...(out.get(k) ?? []), problem])
  return out
})()

/** The problems a setting helps with. */
export function fixesOf(key: string): readonly string[] {
  return BY_KEY.get(key) ?? []
}

/** The problem a search names that this setting helps with, or null. Whole words of the search must start words of the problem. */
export function fixMatch(key: string, query: string): string | null {
  const q = query.trim().toLowerCase()
  if (q.length < 3) return null
  const words = q.split(/\s+/)
  for (const p of fixesOf(key)) {
    const pw = p.split(' ')
    if (words.every((w) => pw.some((x) => x.startsWith(w)))) return p
  }
  return null
}
