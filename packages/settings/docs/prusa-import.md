# Importing PrusaSlicer presets

`importPrusaIni(text, fileName)` reads a PrusaSlicer `.ini`: one exported preset, an exported project configuration (print, filament and printer keys in one file, split into one preset per kind), or a config bundle (`[print:Name]`, `[filament:Name]`, `[printer:Name]`, with `inherits` merged and `*abstract*` sections left out). It returns typed presets and, for each, the keys it did not map.

Keys PrusaSlicer shares with us by name (about 150, such as `layer_height`, `brim_width`, `nozzle_diameter`, `filament_diameter`) need no entry. The rest are mapped through `prusa-map.json` (compared with PrusaSlicer commit 30ef591), the value forms are converted where the two differ (for example `fill_density` percent, `gcode_flavor`, `ensure_vertical_shell_thickness`), and percent speeds are turned into millimeters per second from the preset's own base speed.

Composite conversions: `support_material`, `support_material_auto` and the style set `enable_support` and `support_type`; `first_layer_speed` sets the first layer wall and infill speeds; `ironing` and `ironing_type` give one ironing type; `bed_temperature` sets the smooth and textured PEI plates (and their first layer values); `travel_ramping_lift` gives the z hop type.

## Renamed keys

| PrusaSlicer | SlicerX |
| --- | --- |
| `arc_fitting` | `enable_arc_fitting` |
| `avoid_crossing_perimeters` | `reduce_crossing_wall` |
| `avoid_crossing_perimeters_max_detour` | `max_travel_detour_distance` |
| `bed_shape` | `printable_area` |
| `before_layer_gcode` | `before_layer_change_gcode` |
| `bottom_fill_pattern` | `bottom_surface_pattern` |
| `bottom_solid_layers` | `bottom_shell_layers` |
| `bottom_solid_min_thickness` | `bottom_shell_thickness` |
| `bridge_flow_ratio` | `bridge_flow` |
| `brim_separation` | `brim_object_gap` |
| `complete_objects` | `print_sequence` |
| `deretract_speed` | `deretraction_speed` |
| `disable_fan_first_layers` | `close_fan_the_first_x_layers` |
| `dont_support_bridges` | `bridge_no_support` |
| `end_filament_gcode` | `filament_end_gcode` |
| `end_gcode` | `machine_end_gcode` |
| `external_perimeter_acceleration` | `outer_wall_acceleration` |
| `external_perimeter_extrusion_width` | `outer_wall_line_width` |
| `external_perimeter_speed` | `outer_wall_speed` |
| `external_perimeters_first` | `wall_sequence` |
| `extruder_clearance_height` | `extruder_clearance_height_to_rod` |
| `extrusion_multiplier` | `filament_flow_ratio` |
| `extrusion_width` | `line_width` |
| `fan_below_layer_time` | `fan_cooling_layer_time` |
| `filament_colour` | `default_filament_colour` |
| `filament_deretract_speed` | `filament_deretraction_speed` |
| `filament_retract_before_travel` | `filament_retraction_minimum_travel` |
| `filament_retract_layer_change` | `filament_retract_when_changing_layer` |
| `filament_retract_length` | `filament_retraction_length` |
| `filament_retract_speed` | `filament_retraction_speed` |
| `filament_shrinkage_compensation_xy` | `filament_shrink` |
| `fill_angle` | `infill_direction` |
| `fill_density` | `sparse_infill_density` |
| `fill_pattern` | `sparse_infill_pattern` |
| `first_layer_acceleration` | `initial_layer_acceleration` |
| `first_layer_extrusion_width` | `initial_layer_line_width` |
| `first_layer_height` | `initial_layer_print_height` |
| `first_layer_infill_speed` | `initial_layer_infill_speed` |
| `first_layer_temperature` | `nozzle_temperature_initial_layer` |
| `fuzzy_skin_point_dist` | `fuzzy_skin_point_distance` |
| `gap_fill_enabled` | `gap_fill_target` |
| `gap_fill_speed` | `gap_infill_speed` |
| `gcode_resolution` | `resolution` |
| `infill_acceleration` | `sparse_infill_acceleration` |
| `infill_extrusion_width` | `sparse_infill_line_width` |
| `infill_overlap` | `infill_wall_overlap` |
| `infill_speed` | `sparse_infill_speed` |
| `ironing_flowrate` | `ironing_flow` |
| `layer_gcode` | `layer_change_gcode` |
| `machine_max_feedrate_e` | `machine_max_speed_e` |
| `machine_max_feedrate_x` | `machine_max_speed_x` |
| `machine_max_feedrate_y` | `machine_max_speed_y` |
| `machine_max_feedrate_z` | `machine_max_speed_z` |
| `max_fan_speed` | `fan_max_speed` |
| `max_print_height` | `printable_height` |
| `max_volumetric_extrusion_rate_slope_positive` | `max_volumetric_extrusion_rate_slope` |
| `min_fan_speed` | `fan_min_speed` |
| `min_print_speed` | `slow_down_min_speed` |
| `only_one_perimeter_first_layer` | `only_one_wall_first_layer` |
| `output_filename_format` | `filename_format` |
| `overhangs` | `detect_overhang_wall` |
| `pause_print_gcode` | `machine_pause_gcode` |
| `perimeter_acceleration` | `inner_wall_acceleration` |
| `perimeter_extrusion_width` | `inner_wall_line_width` |
| `perimeter_generator` | `wall_generator` |
| `perimeter_speed` | `inner_wall_speed` |
| `perimeters` | `wall_loops` |
| `prefer_clockwise_movements` | `wall_direction` |
| `retract_before_travel` | `retraction_minimum_travel` |
| `retract_layer_change` | `retract_when_changing_layer` |
| `retract_length` | `retraction_length` |
| `retract_lift` | `z_hop` |
| `retract_speed` | `retraction_speed` |
| `scarf_seam_entire_loop` | `seam_slope_entire_loop` |
| `scarf_seam_length` | `seam_slope_min_length` |
| `scarf_seam_on_inner_perimeters` | `seam_slope_inner_walls` |
| `scarf_seam_only_on_smooth` | `seam_slope_conditional` |
| `scarf_seam_placement` | `seam_slope_type` |
| `scarf_seam_start_height` | `seam_slope_start_height` |
| `seam_gap_distance` | `seam_gap` |
| `skirts` | `skirt_loops` |
| `slowdown_below_layer_time` | `slow_down_layer_time` |
| `small_perimeter_speed` | `small_perimeter_speed` |
| `solid_infill_acceleration` | `internal_solid_infill_acceleration` |
| `solid_infill_below_area` | `minimum_sparse_infill_area` |
| `solid_infill_extrusion_width` | `internal_solid_infill_line_width` |
| `solid_infill_speed` | `internal_solid_infill_speed` |
| `spiral_vase` | `spiral_mode` |
| `start_filament_gcode` | `filament_start_gcode` |
| `start_gcode` | `machine_start_gcode` |
| `support_material_bottom_contact_distance` | `support_bottom_z_distance` |
| `support_material_bottom_interface_layers` | `support_interface_bottom_layers` |
| `support_material_buildplate_only` | `support_on_build_plate_only` |
| `support_material_contact_distance` | `support_top_z_distance` |
| `support_material_extrusion_width` | `support_line_width` |
| `support_material_interface_contact_loops` | `support_interface_loop_pattern` |
| `support_material_interface_layers` | `support_interface_top_layers` |
| `support_material_interface_pattern` | `support_interface_pattern` |
| `support_material_interface_spacing` | `support_interface_spacing` |
| `support_material_interface_speed` | `support_interface_speed` |
| `support_material_pattern` | `support_base_pattern` |
| `support_material_spacing` | `support_base_pattern_spacing` |
| `support_material_speed` | `support_speed` |
| `support_material_style` | `support_style` |
| `support_material_threshold` | `support_threshold_angle` |
| `support_material_xy_spacing` | `support_object_xy_distance` |
| `support_tree_angle` | `tree_support_branch_angle_organic` |
| `support_tree_angle_slow` | `tree_support_angle_slow` |
| `support_tree_branch_diameter` | `tree_support_branch_diameter_organic` |
| `support_tree_branch_diameter_angle` | `tree_support_branch_diameter_angle` |
| `support_tree_branch_distance` | `tree_support_branch_distance_organic` |
| `support_tree_tip_diameter` | `tree_support_tip_diameter` |
| `support_tree_top_rate` | `tree_support_top_rate` |
| `temperature` | `nozzle_temperature` |
| `thin_walls` | `detect_thin_wall` |
| `toolchange_gcode` | `change_filament_gcode` |
| `top_fill_pattern` | `top_surface_pattern` |
| `top_infill_extrusion_width` | `top_surface_line_width` |
| `top_solid_infill_acceleration` | `top_surface_acceleration` |
| `top_solid_infill_speed` | `top_surface_speed` |
| `top_solid_layers` | `top_shell_layers` |
| `top_solid_min_thickness` | `top_shell_thickness` |
| `travel_max_lift` | `travel_slope` |
| `wipe_into_infill` | `flush_into_infill` |
| `wipe_into_objects` | `flush_into_objects` |
| `wipe_tower` | `enable_prime_tower` |
| `xy_size_compensation` | `xy_contour_compensation` |

## Projects

`prusaProjectSettings(text)` reads `Metadata/Slic3r_PE.config` from a PrusaSlicer `.3mf`, where each line is written as `; key = value`, and returns the values in the form `project_settings.config` has in an Orca or Bambu Studio project. A PrusaSlicer project then opens with its settings the same way. `prusaOverrides(meta)` does the same for one object's or volume's settings from `Metadata/Slic3r_PE_model.config`.

## Ignored keys

Resin printer (SLA) keys, preset ids and compatibility bookkeeping, host credentials, the thumbnails and binary G-code options, and project placement keys (`wipe_tower_x`, `wipe_tower_y`) are not print settings and are dropped without being counted.

## Not mapped

SlicerX has no setting with the same meaning for these 76 keys, so an imported preset loses them and reports them. For some of them the import report names the closest SlicerX setting, from `import-nearest.json`. The keys:

`autoemit_temperature_commands`, `automatic_extrusion_widths`, `automatic_infill_combination`, `automatic_infill_combination_max_layer_height`, `avoid_crossing_curled_overhangs`, `bed_temperature_extruder`, `between_objects_gcode`, `color_change_gcode`, `colorprint_heights`, `cooling_perimeter_transition_distance`, `cooling_slowdown_logic`, `custom_parameters_filament`, `custom_parameters_print`, `custom_parameters_printer`, `duplicate_distance`, `enable_dynamic_fan_speeds`, `enable_dynamic_overhang_speeds`, `enable_pressure_advance_during_ramming`, `extra_perimeters`, `extrusion_axis`, `fan_always_on`, `filament_abrasive`, `filament_change_time`, `filament_flush_speed`, `filament_flush_volume`, `filament_infill_max_crossing_speed`, `filament_infill_max_speed`, `filament_load_time`, `filament_purge_multiplier`, `filament_ramming_initial_delay`, `filament_ramming_temperature_delta`, `filament_spool_weight`, `filament_unload_time`, `first_layer_acceleration_over_raft`, `first_layer_solid_infill_speed`, `first_layer_speed_over_raft`, `gcode_substitutions`, `infill_every_layers`, `infill_first`, `infill_only_where_needed`, `initial_layer_height`, `machine_limits_usage`, `max_print_speed`, `max_volumetric_extrusion_rate_slope_negative`, `max_volumetric_speed`, `multimaterial_purging`, `nozzle_high_flow`, `only_retract_when_crossing_perimeters`, `over_bridge_speed`, `overhang_fan_speed_0`, `overhang_fan_speed_1`, `overhang_fan_speed_2`, `overhang_fan_speed_3`, `overhang_speed_0`, `overhang_speed_1`, `overhang_speed_2`, `overhang_speed_3`, `scarf_seam_max_segment_length`, `seam_preferred_direction`, `seam_preferred_direction_jitter`, `solid_infill_every_layers`, `solid_layers`, `solid_min_thickness`, `stuck_filament_detection`, `support_material_closing_radius`, `support_material_synchronize_layers`, `support_material_with_sheath`, `support_tree_branch_diameter_double_wall`, `top_one_perimeter_type`, `travel_lift_before_obstacle`, `travel_short_distance_acceleration`, `use_volumetric_e`, `variable_layer_height`, `wipe_tower_acceleration`, `wiping_volumes_matrix`, `wiping_volumes_use_custom_matrix`.
