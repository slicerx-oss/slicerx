// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The named sections inside each settings tab, in the order they show. A key goes to the first section whose pattern
// matches it, and the tab's section without a pattern takes the rest. Sections fold to one line with a summary of their values.
import type { SettingIntent } from '@slicerx/contracts'

export interface SettingSection {
  id: string
  label: string
  /** Absent on the one section that takes every key the others don't. */
  match?: RegExp
}

export const SECTIONS: Readonly<Record<SettingIntent, readonly SettingSection[]>> = {
  quality: [
    { id: 'layers', label: 'Layers and line width', match: /^layer_height$|^initial_layer_print_height|line_width$|^smart_layer|^precise_z_height|^slicing_mode|^initial_layer_min_bead_width|^zaa_/ },
    { id: 'seam', label: 'Seam', match: /^seam_|^scarf_|^wipe_on_loops|^wipe_inward|^wipe_before_external_loop|^staggered_inner_seams/ },
    { id: 'walls', label: 'Walls', match: /^wall_|^precise_outer_wall|^only_one_wall|^detect_thin_wall|^min_bead_width|^min_feature_size|^is_infill_first|^unsupported_wall_last/ },
    { id: 'surfaces', label: 'Top and bottom surfaces', match: /^top_surface_pattern|^bottom_surface_pattern|^internal_solid_infill_pattern|^top_bottom_infill_wall_overlap|^min_width_top_surface/ },
    { id: 'overhangs', label: 'Overhangs and bridges', match: /^(?!.*flow_ratio).*(bridge|overhang|counterbore)/ },
    { id: 'precision', label: 'Precision' },
    { id: 'flow', label: 'Flow', match: /flow_ratio|extrusion_rate_smoothing|max_volumetric_extrusion|small_area_infill_flow/ },
  ],
  strength: [
    { id: 'walls', label: 'Walls', match: /^wall_loops|^alternate_extra_wall/ },
    { id: 'shells', label: 'Top and bottom shells', match: /_shell_|_surface_density|surface_fill_order|^top_surface_expansion|layer_direction|^interface_shells|^extra_solid_infills|^center_of_surface_pattern|^solid_infill_|^detect_narrow_internal_solid_infill|^ensure_vertical_shell_thickness/ },
    { id: 'infill', label: 'Infill' },
    { id: 'interlocking', label: 'Interlocking', match: /^interlocking/ },
  ],
  speed: [
    { id: 'walls', label: 'Walls and surfaces', match: /wall_speed|^top_surface_speed|^small_perimeter|^gap_infill_speed|^slowdown_for_curled/ },
    { id: 'features', label: 'Infill, supports and bridges' },
    { id: 'first', label: 'First layer', match: /^initial_layer|^slow_down_layers/ },
    { id: 'travel', label: 'Travel', match: /travel|^reduce_crossing_wall|^reduce_infill_retraction|wipe_speed/ },
    { id: 'motion', label: 'Acceleration and jerk', match: /accel|jerk|junction/ },
  ],
  supports: [
    { id: 'where', label: 'Where supports go' },
    { id: 'touch', label: 'Where they touch the part', match: /z_distance|xy_distance|interface|^support_base_pattern|^support_object_first_layer_gap|^support_ironing/ },
    { id: 'tree', label: 'Tree supports', match: /^tree_support/ },
  ],
  adhesion: [
    { id: 'brim', label: 'Brim', match: /brim/ },
    { id: 'skirt', label: 'Skirt and draft shield', match: /skirt|draft_shield/ },
    { id: 'raft', label: 'Raft' },
  ],
  multicolor: [
    { id: 'tower', label: 'Prime tower', match: /prime_tower|^wipe_tower|^enable_tower/ },
    { id: 'flush', label: 'Flushing and ooze', match: /^flush_into|^ooze|^standby|^toolchange|^single_extruder_multi_material_priming/ },
    { id: 'features', label: 'Filament for features', match: /filament/ },
    { id: 'regions', label: 'Color regions' },
  ],
  effects: [
    { id: 'ironing', label: 'Ironing', match: /ironing/ },
    { id: 'fuzzy', label: 'Fuzzy skin', match: /^fuzzy_skin/ },
    { id: 'vase', label: 'Spiral vase', match: /^spiral_/ },
    { id: 'waves', label: 'Overhang waves', match: /^wave_overhang/ },
    { id: 'other', label: 'More effects' },
  ],
  output: [
    { id: 'order', label: 'Print order', match: /^print_sequence|^print_order|^exclude_object/ },
    { id: 'gcode', label: 'G-code and file' },
  ],
}

/** The section a key sits in, within its tab. */
export function sectionOf(intent: SettingIntent, key: string): SettingSection {
  const list = SECTIONS[intent]
  return list.find((s) => s.match?.test(key)) ?? list.find((s) => !s.match)!
}
