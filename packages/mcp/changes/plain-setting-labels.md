### Changed

- `slicerx_explain_setting`, `slicerx_find_settings` and `slicerx_validate_config` name 186 settings with plain words instead of their key read aloud, such as "Brim follows elephant foot compensation" for `brim_use_efc_outline`, "Filament for outer walls" for `outer_wall_filament_id` and "Print by object G-code" for `printing_by_object_gcode`. No label has a clipped word, a lone `x` or a unit written inside it. The app's settings panel, search and preset compare read the same labels. Keys, values and units are unchanged.
