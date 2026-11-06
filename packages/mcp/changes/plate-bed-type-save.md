### Fixed

- A plate type set with `slicerx_app_plate_add` or `slicerx_app_plate_settings` (`bedType`) is saved in the plate's entry of the project file as `bed_type`, the key other apps read there, and as `curr_bed_type` with the same name. Before, only `curr_bed_type` was written, so another slicer opened the plate on the project's plate type. `slicerx_inspect_project` reads it back as `bed_type`. A plate on the default plate type writes neither.
