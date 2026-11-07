### Added

- `slicerx_app_layer_profile` 1.0.0 reads a plate's own layer heights in the running app (the shown plate, or `plate` by number or id): `mode`, what the plate slices with (`calibration`, `resume`, `own`, `sleipnir` or `fixed`; a calibration plate and a resume plan keep their own layers over a profile), `profile` as [height above the bed mm, layer height mm] points or null, the printer's `limits` (`min_mm`, `max_mm`, `first_layer_mm`), the plate's `top_mm`, the `layers` the profile gives, `layer_height_mm` and a `revision`. `slicerx_project_layer_profile` 1.0.0 sets one (`action: set` with `points`) or clears it (`action: reset`), as one toolbar Undo step, and returns it read back. Heights outside the printer's limits are refused with `invalid_input`; an optional `revision` from the read refuses an edit after another change with `busy`, as does an edit while the app loads, slices or edits. Both need the app link; the app link gains `layers.profile.get` (read) and `layers.profile.edit` (edit).

### Changed

- `slicerx_app_plate_settings` 1.2.0 with `replace: true` keeps the plate's own layer heights (set and reset them with `slicerx_project_layer_profile`); the other overrides are replaced as before.
