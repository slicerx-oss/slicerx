### Added

- `slicerx_project_mixed_filaments` 1.0.0 lists the open project's mixed filaments: each one's `id` (the filament number objects and paint use, 29 to 32), `name`, its two loaded filaments (`components`), the `ratio` in layers, the first `cycle` of filaments layer by layer, and an approximate `color` with the two filaments' `colors`.
- `slicerx_project_add_mixed_filament` 1.0.0 adds a mix of two loaded filaments with a ratio in layers (each side 1 to 20). It takes the highest free number from 32 down, four mixes at most, and answers with the mix and the project's mixes read back. A slice prints each layer of a region on the mix in one of the two filaments, the second's layers spread through each cycle (2:1 prints A, A, B).
- `slicerx_project_set_mixed_filament` 1.0.0 changes a mix's filaments, ratio or name, and `slicerx_project_remove_mixed_filament` 1.0.0 deletes one, the objects on it going back to its first filament; both answer with the mixes read back.
- `slicerx_project_set_object_filament` 1.0.0 prints an object with a loaded filament or a mix by its number, and answers with the object's filaments as the slice reads them.
- `slicerx_app_mixed_filaments` 1.0.0 reads the mixes of the project open in the app, and `slicerx_app_mixed_filaments_set` 1.0.0 sets them as a whole list in one Undo step, a mix the list leaves out taking its parts and paint back to its first filament.

### Changed

- `slicerx_project_show` 1.4.0 lists `mixed_filaments` when the project has any, and each plate's slice carries the mixes its objects use, by part or by paint, as the `mixed_filaments` setting.
- `slicerx_project_add_filament` 1.3.0 refuses a filament number a mix holds.
- `slicerx_project_duplicate` 1.2.0 copies the filament an object was set to print with.
- `slicerx_project_object_nozzle` 1.1.0 counts an object on a mix as its two filaments.
- `slicerx_app_paint` 1.1.0 lists the project's mixes as `colorMixes`, and `slicerx_app_paint_preview` 1.4.0 takes a mix's number as a color state.
