### Changed

- `slicerx_inspect_project` 1.3.0 lists a plate's own plate type as `bed_type` (such as `Textured Cool Plate`) when the project sets one for that plate in its `bed_type` metadata.

### Fixed

- `slicerx_slice_file` and `slicerx_estimate_file` slice a project's plate with that plate's own plate type (`curr_bed_type`, which picks the bed temperatures) when the file sets one for it, with project_settings: true. Before, every plate took the project's plate type. A plate set to "Default Plate", or to none, still takes the project's.
- `slicerx_app_plate_add` and `slicerx_app_plate_settings` take `textured-cool` and `supertack` as a plate's `bedType`. Before, they were refused.
