### Fixed

- `slicerx_slice_file` 1.10.0 and `slicerx_estimate_file` 1.8.0 with `project_settings`, and `slicerx_inspect_project` 1.4.0, read a Bambu Lab H3C project saved by Bambu Studio 2.9.1 whose 2.85 mm TPU lists only its TPU285 variant (`filament_self_index` 1, 1, 2, 2, 3, 3, 4). Each filament takes the values of the hotend it is on (`filament_nozzle_map`), else its only variant, as the engine and `sx project-settings` read it. A project synced with the printer, which names each hotend's type (`extruder_nozzle_volume_type`) and calls the extruder Hybrid (`nozzle_volume_type`), reads and slices the same way. Before, both were refused with `invalid_settings` ("Project variants: identity 4 needs exactly one Direct Drive Standard entry", or "Direct Drive Hybrid" for a synced one).

