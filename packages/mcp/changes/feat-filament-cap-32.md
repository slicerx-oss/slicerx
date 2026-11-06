### Changed

- A project holds 32 filaments, up from 16. `slicerx_project_add_filament` 1.1.0 adds up to the 32nd and refuses a 33rd; `slicerx_project_set_filament` 1.1.0, `slicerx_slice_file` 1.8.0 and `slicerx_estimate_file` 1.6.0 (`filaments`) and `slicerx_step_read` 1.4.0 (`filaments`, `max_filaments`) take filaments 1 to 32.
