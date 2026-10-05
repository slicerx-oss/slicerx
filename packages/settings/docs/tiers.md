# Tiers and Easy mappings

How the settings are grouped for the app. Every Orca key stays in `schema.json`, so profiles import and export unchanged. This is grouping, naming and mapping. No default value changed. The tier table lives in `scripts/tiers.json`; `node scripts/apply-tiers.mjs` writes it into `schema.json`, then run `gen-defaults.mjs` and `gen-reference.mjs`.

## Tiers

Each process key has `mode` and, for the user tiers, an `intent`.

- `simple`: the keys the Simple controls drive directly (6): `layer_height`, `wall_loops`, `sparse_infill_density`, `enable_support`, `brim_type`, `smart_layer`. The Simple panel shows 7 controls, not these rows.
- `advanced`: a curated list of 82 process keys grouped by `intent`.
- `expert`: every other process key, shown behind search. 291 keys.
- `develop`: developer only, never listed (7 keys, including `resolution` and `slice_closing_radius`).
- `hidden`: profile keys such as `inherits`, `print_extruder_variant`, `compatible_printers`, `wiping_volumes_extruders`, `prime_volume`, and the filament and printer profile keys. Imported and exported, shown nowhere.

Tiers are cumulative: Advanced lists simple plus advanced keys, Expert lists all three. `settingsForTier(section, tier, { filamentCount })` and `isVisible(def, ctx)` (Rust: `settings_for_tier`, `is_visible`) do the filtering.

Intents: quality, strength, speed, supports, adhesion, multicolor, effects, and output (G-code and file keys, Expert only). Advanced keys by intent:

- quality (26): `initial_layer_print_height`, `line_width`, `outer_wall_line_width`, `inner_wall_line_width`, `initial_layer_line_width`, `sparse_infill_line_width`, `top_surface_line_width`, `print_flow_ratio`, `seam_position`, `seam_gap`, `seam_slope_conditional`, `wall_generator`, `wall_sequence`, `wall_direction`, `precise_outer_wall`, `only_one_wall_top`, `only_one_wall_first_layer`, `elefant_foot_compensation`, `xy_contour_compensation`, `xy_hole_compensation`, `enable_arc_fitting`, `thick_bridges`, `hole_to_polyhole`, `top_surface_pattern`, `bottom_surface_pattern`, `internal_solid_infill_pattern`
- strength (9): `top_shell_thickness`, `bottom_shell_thickness`, `sparse_infill_pattern`, `top_surface_density`, `bottom_surface_density`, `infill_direction`, `infill_anchor_max`, `alternate_extra_wall`, `interlocking_beam`
- speed (1): `outer_wall_speed`
- supports (16): `support_type`, `support_style`, `support_threshold_angle`, `support_on_build_plate_only`, `support_critical_regions_only`, `support_object_xy_distance`, `support_top_z_distance`, `support_bottom_z_distance`, `support_interface_top_layers`, `support_interface_bottom_layers`, `support_base_pattern`, `support_interface_pattern`, `tree_support_branch_diameter`, `tree_support_tip_diameter`, `tree_support_branch_angle`, `tree_support_wall_count`
- adhesion (12): `brim_width`, `brim_object_gap`, `skirt_loops`, `skirt_distance`, `skirt_height`, `skirt_type`, `min_skirt_length`, `raft_layers`, `raft_contact_distance`, `raft_expansion`, `draft_shield`, `tree_support_brim_width`
- multicolor (14): `enable_prime_tower`, `prime_tower_width`, `prime_tower_brim_width`, `prime_tower_auto_position`, `wipe_tower_rotation_angle`, `wipe_tower_extra_spacing`, `wipe_tower_no_sparse_layers`, `flush_into_infill`, `flush_into_objects`, `flush_into_support`, `support_filament`, `support_interface_filament`, `ooze_prevention`, `standby_temperature_delta`
- effects (4): `fuzzy_skin`, `fuzzy_skin_thickness`, `spiral_mode`, `ironing_type`

Fuzzy skin is under effects: `fuzzy_skin` and `fuzzy_skin_thickness` in Advanced, noise type, point distance and first layer in Expert. The support style (`support_type`, `support_style`) and `support_threshold_angle` are Advanced. `print_sequence` belongs in the plate menu and `timelapse_type` in the send dialog; both stay Expert keys.

## Multi-color keys

A key with `showWhen: "multicolor"` is listed only when two or more filaments are in use. That is every process key of the multimaterial group (prime tower, flush, filament ids per feature), plus `enable_mixed_color_sublayer` and the `mmu_segmented_*` keys. The app passes the filament count; the schema does not read the plate.

## Simple controls

| Control | Values | Writes |
| --- | --- | --- |
| Detail | 0 to 100 | `layer_height`, `initial_layer_print_height`, `top_shell_thickness` 1.0 mm, `bottom_shell_thickness` 0.6 mm, and the layer counts derived from them |
| Vary layer height (under Detail) | on or off | `smart_layer`: off, quality, or strength when Strength is 70 or more; with it on, `smart_layer_min_height` and `smart_layer_max_height` |
| Strength | 0 to 100 | `wall_loops`, `sparse_infill_density`, `sparse_infill_pattern` gyroid |
| Speed | quality, balanced, fast, fastest | scales the preset's speeds (50, 100, 124 and 166 percent), capped by the filament's volumetric limit and the machine's acceleration limit |
| Supports | off, auto, painted | `enable_support`; auto is tree(auto) from the build plate, painted is tree(manual); threshold 25 degrees |
| Brim | on or off | `brim_type` auto or none, `brim_width` 5 mm |

Labels, hints and aliases are in `easy-map.json` under `controls.<name>` (`labels`, `hints`, `aliases`), separate from the stored values, so a rename touches one file. The five sleipnir tuning keys (`smart_layer_min_height`, `smart_layer_max_height`, `smart_layer_smoothing`, `smart_layer_smoothing_radius`, `smart_layer_max_step_ratio`) are Expert and derived from nozzle, material and mode.

Old values stay readable for good, in both languages: speed `silent`, `standard`, `sport`, `ludicrous` (and `gentle`, `maximum`) read as quality, balanced, fast, fastest; supports `everywhere` reads as auto (the build-plate-only flag is an Advanced key now); `smartLayer` is used as the exact `smart_layer` mode when `varyLayerHeight` is absent. Write only the new values. `EasySettings.varyLayerHeight` replaces `smartLayer`.

Shell thickness is in millimeters (`top_shell_thickness`, `bottom_shell_thickness`, Advanced). The layer counts are Expert and derived: after any edit call `deriveShellLayers(config)` (Rust `derive_shell_layers`), which sets each count to the ceiling of thickness over layer height.

## Advanced choices

Two choices set several Orca keys together. `easyChoices()` lists them with labels and hints, `applyChoice(config, name, value)` writes one, and `choiceValue(config, name)` reads the current value back (undefined for a custom mix). Rust: `easy_choices`, `apply_choice`, `choice_value`.

- `overhangSlowdown`: off, on, careful. Off turns `enable_overhang_speed` and `slowdown_for_curled_perimeters` off, on turns the first on, careful turns both on.
- `unsupportedOverhangs`: none, loops, waves. Loops sets `extra_perimeters_on_overhangs`, waves sets `wave_overhangs`; each clears the other.

`wave_overhangs` and its seven tuning keys (`wave_overhang_*`) are now in the schema, as Expert keys with the defaults the engine already uses.
