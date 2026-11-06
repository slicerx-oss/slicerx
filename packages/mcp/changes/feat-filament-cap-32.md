### Changed

- A project holds 32 filaments, up from 16. `slicerx_project_add_filament` 1.1.0 adds up to the 32nd and refuses a 33rd; `slicerx_project_set_filament` 1.1.0, `slicerx_slice_file` 1.8.0 and `slicerx_estimate_file` 1.6.0 (`filaments`) and `slicerx_step_read` 1.4.0 (`filaments`, `max_filaments`) take filaments 1 to 32.

### Fixed

- `slicerx_paint_preview` and `slicerx_app_paint_preview` 1.0.1 refuse a paint state above 18, and a replace from one, with a plain message. A paint text names filaments 1 to 18 only, so before, filament 19 or higher was saved as filament 18 without a word.
